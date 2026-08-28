import { test, before } from 'node:test';
import assert from 'node:assert';

// Same env-seeding pattern as revocation-store.test.ts / oauth-tokens.test.ts: loadEnv() validates
// the WHOLE env, so seed the unrelated required vars before importing anything that touches config.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const { isSafeBlobPath, paginate, PAGE_CHARS, FINANCE_DOC_INDEXES, toContainerRelative, financeStoreConfigError } =
  await import('./get-document.js');
const { isLaneAllowed } = await import('./search-privileged.js');

// ── Finance store config gate (2026-08-28: BLOB_BACKEND=s3 no longer needs the Azure key) ─────────

test('financeStoreConfigError: BLOB_BACKEND=azure still requires the Azure key (no regression)', () => {
  assert.equal(
    financeStoreConfigError({ BLOB_BACKEND: 'azure', AZURE_CFO_STORAGE_ACCOUNT: 'otchealthcfodata', AZURE_CFO_STORAGE_KEY: '' }),
    'Finance store not configured (AZURE_CFO_STORAGE_KEY unset).',
  );
  assert.equal(
    financeStoreConfigError({ BLOB_BACKEND: 'azure', AZURE_CFO_STORAGE_ACCOUNT: 'otchealthcfodata', AZURE_CFO_STORAGE_KEY: 'k' }),
    null,
  );
});

test('financeStoreConfigError: BLOB_BACKEND=s3 with NO Azure key present is still CONFIGURED', () => {
  // The whole point of the fix: pruning AZURE_CFO_STORAGE_KEY from the task def must not silently
  // kill kb_get_document once fetchBlobRaw is routing to S3 anyway.
  assert.equal(
    financeStoreConfigError({ BLOB_BACKEND: 's3', AZURE_CFO_STORAGE_ACCOUNT: 'otchealthcfodata', AZURE_CFO_STORAGE_KEY: '' }),
    null,
  );
});

test('financeStoreConfigError: the account name is load-bearing on EITHER backend', () => {
  assert.equal(
    financeStoreConfigError({ BLOB_BACKEND: 's3', AZURE_CFO_STORAGE_ACCOUNT: '', AZURE_CFO_STORAGE_KEY: '' }),
    'Finance store not configured (AZURE_CFO_STORAGE_ACCOUNT unset).',
  );
  assert.equal(
    financeStoreConfigError({ BLOB_BACKEND: 'azure', AZURE_CFO_STORAGE_ACCOUNT: '', AZURE_CFO_STORAGE_KEY: 'k' }),
    'Finance store not configured (AZURE_CFO_STORAGE_ACCOUNT unset).',
  );
});

// ── Ring boundary (the load-bearing property) ────────────────────────────────────────────────────

test('RING: cfo (and the exec ring) may fetch finance documents; cto/developer/external may NOT', () => {
  for (const index of FINANCE_DOC_INDEXES) {
    assert.equal(isLaneAllowed(index, 'cfo'), true, `cfo must be allowed on ${index}`);
    assert.equal(isLaneAllowed(index, 'exec'), true, `exec must be allowed on ${index}`);
    // The broad externally-reachable connector identity is excluded BY DESIGN (see
    // search-privileged.ts header). kb_get_document must inherit that, never widen it.
    assert.equal(isLaneAllowed(index, 'cto'), false, `cto must be refused on ${index}`);
    assert.equal(isLaneAllowed(index, 'developer'), false, `developer must be refused on ${index}`);
    assert.equal(isLaneAllowed(index, ''), false, 'unknown/external caller must be refused');
    assert.equal(isLaneAllowed(index, undefined), false, 'missing caller must be refused');
  }
});

// ── Path hygiene ─────────────────────────────────────────────────────────────────────────────────

test('paths: container-relative only — traversal, absolute, URL, and backslash forms are refused', () => {
  assert.equal(isSafeBlobPath('_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt'), true);
  assert.equal(isSafeBlobPath('_TEXT/INND/Conversions/file with spaces (1).xlsx.txt'), true);
  assert.equal(isSafeBlobPath('../secrets'), false);
  assert.equal(isSafeBlobPath('a/../../b'), false);
  assert.equal(isSafeBlobPath('/absolute/path'), false);
  assert.equal(isSafeBlobPath('https://evil.example/x'), false);
  assert.equal(isSafeBlobPath('a\\b'), false);
  assert.equal(isSafeBlobPath(''), false);
  assert.equal(isSafeBlobPath('x'.repeat(2000)), false);
});

// ── Pagination + completeness proof ──────────────────────────────────────────────────────────────

test('paginate: multi-page slicing reassembles to the exact original (no loss, no overlap)', () => {
  const doc = Array.from({ length: 5000 }, (_, i) => `row-${i},value-${i * 7}`).join('\n');
  const first = paginate(doc, 1);
  assert.equal(first.total_chars, doc.length);
  let reassembled = '';
  for (let p = 1; p <= first.total_pages; p++) reassembled += paginate(doc, p).content;
  assert.equal(reassembled, doc, 'concatenated pages must equal the original document byte-for-byte');
  assert.equal(first.total_pages, Math.ceil(doc.length / PAGE_CHARS));
});

test('paginate: line counting matches auditor expectations (wc -l semantics + final unterminated line)', () => {
  assert.equal(paginate('', 1).total_lines, 0, 'empty doc = 0 lines');
  assert.equal(paginate('one line no newline', 1).total_lines, 1);
  assert.equal(paginate('a\nb\nc\n', 1).total_lines, 3, 'trailing newline does not invent a 4th line');
  assert.equal(paginate('a\nb\nc', 1).total_lines, 3);
  // The CFO acceptance shape: a 64-row register must report exactly 64 (+header) lines.
  const register = ['note_id,face,net', ...Array.from({ length: 64 }, (_, i) => `N${i + 1},100,90`)].join('\n');
  assert.equal(paginate(register, 1).total_lines, 65);
});

test('paginate: out-of-range page clamps instead of erroring (page 0 -> 1, page 999 -> last)', () => {
  const doc = 'x'.repeat(PAGE_CHARS * 2 + 10);
  assert.equal(paginate(doc, 0).page, 1);
  assert.equal(paginate(doc, 999).page, 3);
  assert.equal(paginate(doc, 999).content.length, 10, 'last page carries the remainder');
});

// ---------------------------------------------------------------------------------------------
// PATH-DIALECT ROUND-TRIP. CFO escalation 2026-08-17: "10 of 10 attempts failed" on paths copied
// VERBATIM from a live kb_search_privileged hit. The finance indexes store paths fully qualified
// (<account>/<container>/<blob path>); fetchBlobRaw wants container-relative. The round-trip was
// broken by construction, which is why it failed every time rather than intermittently -- and a
// retrieval tool that says found:false for a document that EXISTS manufactures false negatives.
// Verified live before the fix: the same document returns pages=1 once the prefix is stripped.
// ---------------------------------------------------------------------------------------------
test('a path copied verbatim from a search hit is normalised to container-relative', () => {
  const searchEmitted =
    'otchealthcfodata/cfo-source-docs/mail-archive-attachments/fy2021-close-innd/email-sweep-2021-12/2021-12-10_Fruci_TrialBalance_2019.xlsx';
  assert.equal(
    toContainerRelative(searchEmitted, 'otchealthcfodata', 'cfo-source-docs'),
    'mail-archive-attachments/fy2021-close-innd/email-sweep-2021-12/2021-12-10_Fruci_TrialBalance_2019.xlsx',
  );
});

test('an already container-relative path is returned BYTE-IDENTICAL (no regression)', () => {
  const already = '_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt';
  assert.equal(toContainerRelative(already, 'otchealthcfodata', 'cfo-source-docs'), already);
});

test('a container-qualified path without the account is also accepted', () => {
  assert.equal(
    toContainerRelative('cfo-source-docs/INND/OneDrive/x.docx', 'otchealthcfodata', 'cfo-source-docs'),
    'INND/OneDrive/x.docx',
  );
});

test('the strip is EXACT-PREFIX, not positional: a lookalike path is left alone', () => {
  // Two leading segments that merely RESEMBLE an account/container must not be eaten. A positional
  // "drop the first two segments" would silently corrupt this path and report found:false for a
  // different reason -- trading one invisible failure for another.
  const lookalike = 'otchealthcfodata-archive/cfo-source-docs-old/report.xlsx';
  assert.equal(toContainerRelative(lookalike, 'otchealthcfodata', 'cfo-source-docs'), lookalike);
});

test('normalisation is idempotent: normalising twice equals normalising once', () => {
  const p = 'otchealthcfodata/cfo-source-docs/a/b/c.xlsx';
  const once = toContainerRelative(p, 'otchealthcfodata', 'cfo-source-docs');
  assert.equal(toContainerRelative(once, 'otchealthcfodata', 'cfo-source-docs'), once);
});

test('the normalised path still passes the safety predicate', () => {
  // Normalisation must never produce something isSafeBlobPath would reject, or the fix would turn
  // a not-found into a refusal.
  const p = 'otchealthcfodata/cfo-source-docs/mail-archive-attachments/2021-12-10_TB.xlsx';
  assert.equal(isSafeBlobPath(toContainerRelative(p, 'otchealthcfodata', 'cfo-source-docs')), true);
});
