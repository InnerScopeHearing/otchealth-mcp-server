import { test, before } from 'node:test';
import assert from 'node:assert';

// Same env-seeding pattern as get-document.test.ts / oauth-tokens.test.ts: loadEnv() validates the
// WHOLE env, so seed the unrelated required vars before importing anything that touches config.
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

const { KB_LIST_INDEXES, buildListing, paginateItems, storeFor } = await import('./list-documents.js');
const { isLaneAllowed } = await import('./search-privileged.js');

// ── Ring boundary (the load-bearing property, identical to kb_search_privileged/kb_get_document) ──

test('RING: kb_list_documents reuses isLaneAllowed unmodified for every index it serves', () => {
  for (const index of KB_LIST_INDEXES) {
    assert.equal(isLaneAllowed(index, 'exec'), true, `exec must be allowed on ${index}`);
    // The broad externally-reachable connector identity is excluded BY DESIGN.
    assert.equal(isLaneAllowed(index, 'cto'), false, `cto must be refused on ${index}`);
    assert.equal(isLaneAllowed(index, 'default'), false, `default must be refused on ${index}`);
    assert.equal(isLaneAllowed(index, ''), false, 'unknown/external caller must be refused');
    assert.equal(isLaneAllowed(index, undefined), false, 'missing caller must be refused');
  }
});

test('RING: finance indexes allow cfo, refuse clo-personal-only-scoped callers like developer', () => {
  for (const index of ['finance-cfo-source-docs', 'finance-otchealth-cfo-source-docs'] as const) {
    assert.equal(isLaneAllowed(index, 'cfo'), true);
    assert.equal(isLaneAllowed(index, 'developer'), false);
  }
});

test('RING: legal-personal is narrower than legal-company — cfo reaches legal-company but NOT legal-personal', () => {
  assert.equal(isLaneAllowed('legal-company', 'cfo'), true);
  assert.equal(isLaneAllowed('legal-personal', 'cfo'), false);
  assert.equal(isLaneAllowed('legal-personal', 'clo-personal'), true);
});

// ── storeFor mapping ────────────────────────────────────────────────────────────────────────────

test('storeFor: both finance index names resolve to the SAME container (cfo-source-docs)', () => {
  process.env.AZURE_CFO_STORAGE_ACCOUNT = 'otchealthcfodata';
  const a = storeFor('finance-cfo-source-docs');
  const b = storeFor('finance-otchealth-cfo-source-docs');
  assert.equal(a.container, 'cfo-source-docs');
  assert.equal(b.container, 'cfo-source-docs');
  assert.equal(a.account, b.account);
});

test('storeFor: legal indexes resolve to their matching LegalContainer', () => {
  assert.equal(storeFor('legal-company').container, 'company');
  assert.equal(storeFor('legal-personal').container, 'personal');
});

// ── buildListing: sidecar flag, contains filter, exclusion of _TEXT/ from the main set ─────────────

test('buildListing: excludes _TEXT/ rows from the main set and flags has_text_sidecar correctly', () => {
  const mainRows = [
    { name: 'INND/01_Bank-Statements/2019-01.pdf', size: 100, lastModified: '2026-01-01' },
    { name: 'INND/01_Bank-Statements/2019-02.pdf', size: 200, lastModified: '2026-01-02' },
    { name: '_TEXT/INND/01_Bank-Statements/2019-01.pdf.txt', size: 50, lastModified: '2026-01-03' },
  ];
  const textRows = [{ name: '_TEXT/INND/01_Bank-Statements/2019-01.pdf.txt', size: 50, lastModified: '2026-01-03' }];
  const items = buildListing(mainRows, textRows);
  assert.equal(items.length, 2, '_TEXT/ row must not appear in the main item set');
  const jan = items.find((i) => i.key.endsWith('2019-01.pdf'));
  const feb = items.find((i) => i.key.endsWith('2019-02.pdf'));
  assert.equal(jan?.has_text_sidecar, true);
  assert.equal(feb?.has_text_sidecar, false);
});

test('buildListing: contains is a case-insensitive substring match on the key', () => {
  const mainRows = [
    { name: 'INND/statements/2019-01_9145.pdf', size: 1, lastModified: null },
    { name: 'INND/statements/2019-02_1234.pdf', size: 1, lastModified: null },
  ];
  const items = buildListing(mainRows, [], '9145');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.key, 'INND/statements/2019-01_9145.pdf');
  // case-insensitivity
  const upper = buildListing(mainRows, [], '9145'.toUpperCase());
  assert.equal(upper.length, 1);
});

test('buildListing: sorts keys ascending for stable pagination', () => {
  const mainRows = [
    { name: 'z.pdf', size: 1, lastModified: null },
    { name: 'a.pdf', size: 1, lastModified: null },
    { name: 'm.pdf', size: 1, lastModified: null },
  ];
  const items = buildListing(mainRows, []);
  assert.deepEqual(items.map((i) => i.key), ['a.pdf', 'm.pdf', 'z.pdf']);
});

// ── paginateItems: default/cap and offset paging ────────────────────────────────────────────────

test('paginateItems: caps to `max` and reports truncated + next_continuation', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    key: `k${i}`,
    size: null,
    last_modified: null,
    has_text_sidecar: false,
  }));
  const { page, next, truncated } = paginateItems(items, 2);
  assert.equal(page.length, 2);
  assert.equal(truncated, true);
  assert.equal(next, '2');
});

test('paginateItems: continuation resumes from the given offset, and the final page reports truncated=false, next=null', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    key: `k${i}`,
    size: null,
    last_modified: null,
    has_text_sidecar: false,
  }));
  const second = paginateItems(items, 2, '2');
  assert.deepEqual(second.page.map((i) => i.key), ['k2', 'k3']);
  assert.equal(second.truncated, true);
  assert.equal(second.next, '4');

  const last = paginateItems(items, 2, '4');
  assert.deepEqual(last.page.map((i) => i.key), ['k4']);
  assert.equal(last.truncated, false);
  assert.equal(last.next, null);
});

test('paginateItems: an empty listing is not truncated and has no next_continuation', () => {
  const { page, next, truncated } = paginateItems([], 500);
  assert.deepEqual(page, []);
  assert.equal(truncated, false);
  assert.equal(next, null);
});
