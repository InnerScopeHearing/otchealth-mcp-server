import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Same preamble as client.test.ts -- satisfies loadEnv()'s required vars before the handler-level
// tests below transitively call it via handleXeroAttachmentUpload -> xeroConfigured()/getOrgAccess.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
    N8N_WEBHOOK_SECRET: 'x'.repeat(32),
    XERO_CLIENT_ID: 'test-client-id',
    XERO_CLIENT_SECRET: 'test-client-secret',
    XERO_RT_OTCHEALTH: 'bootstrap-rt-otchealth',
    // STATE_BACKEND pinned to 'cosmos' (2026-08-28): this file's Cosmos fixtures below are only
    // reachable while the agent-state dispatcher is actually pointed at cosmos.ts -- STATE_BACKEND's
    // schema default flipped to 'postgres' the same day, and this file predates that flip.
    STATE_BACKEND: 'cosmos',
    COSMOS_ENDPOINT: 'https://test.documents.azure.com',
    COSMOS_DB: 'test',
    COSMOS_KEY: Buffer.from('test-key').toString('base64'),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const { checkAttachmentPayloadIntegrity, filterReportRows, handleXeroAttachmentUpload, handleXeroAttachmentContent, handleXeroRequest } = await import('./tools.js');
const { buildTokenDoc, bootstrapHash } = await import('./client.js');

/**
 * Regression tests for xero_attachment_upload's truncation/corruption guard (CFO P1-B, 2026-07-30;
 * Copilot review, same date: "no test exercising either an expected_bytes/expected_sha256
 * mismatch or the matching upload path"). Pure-function tests, no network: mismatches must return
 * truncated_payload deterministically, and a genuinely matching payload must pass through clean —
 * BEFORE the handler ever calls Xero.
 */

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

test('checkAttachmentPayloadIntegrity: a byte-length mismatch is caught as truncated_payload', () => {
  const buf = Buffer.from('short content');
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: buf.length + 500 });
  assert.ok(result);
  assert.equal(result.error, 'truncated_payload');
  assert.match(result.reason, /expected_bytes was/);
});

test('checkAttachmentPayloadIntegrity: a sha256 mismatch (same length, different bytes) is caught as truncated_payload', () => {
  const buf = Buffer.from('AAAAAAAAAA'); // 10 bytes
  const differentButSameLength = Buffer.from('BBBBBBBBBB'); // 10 bytes, different hash
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_sha256: sha256Hex(differentButSameLength) });
  assert.ok(result, 'a same-length corruption must still be caught -- this is the whole point of hashing over length alone');
  assert.equal(result.error, 'truncated_payload');
  assert.match(result.reason, /expected_sha256 was/);
});

test('checkAttachmentPayloadIntegrity: expected_sha256 comparison is case-insensitive (uppercase hex input matches)', () => {
  const buf = Buffer.from('case insensitivity check');
  const hash = sha256Hex(buf);
  const result = checkAttachmentPayloadIntegrity(buf, hash, { expected_sha256: hash.toUpperCase() });
  assert.equal(result, null);
});

test('checkAttachmentPayloadIntegrity: matching expected_bytes AND expected_sha256 both pass through as null (no refusal)', () => {
  const buf = Buffer.from('the real, complete, untruncated file content'.repeat(50));
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: buf.length, expected_sha256: sha256Hex(buf) });
  assert.equal(result, null);
});

test('checkAttachmentPayloadIntegrity: neither check requested (both undefined) always passes through as null', () => {
  const buf = Buffer.from('no integrity check requested at all');
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), {});
  assert.equal(result, null);
});

test('checkAttachmentPayloadIntegrity: expected_bytes checked BEFORE expected_sha256 -- a length mismatch is reported even if a caller also passed a wrong hash', () => {
  const buf = Buffer.from('twelve bytes'); // 12 bytes
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: 999, expected_sha256: 'f'.repeat(64) });
  assert.ok(result);
  assert.match(result.reason, /expected_bytes was 999/);
});

test('checkAttachmentPayloadIntegrity: a zero expected_bytes never accidentally passes (0 !== real length) for real content', () => {
  const buf = Buffer.from('non-empty');
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: 0 });
  assert.ok(result);
});

// -------------------------------------------------------------------------------------------
// filterReportRows (CFO P1-C, 2026-07-30; Copilot review, same date: "No test exercises the
// newly applied report filter, despite it recursively dropping financial rows and totals").
// -------------------------------------------------------------------------------------------

function reportBody(rows: unknown[]): unknown {
  return { Reports: [{ ReportID: 'TrialBalance', Rows: rows }] };
}

function accountRow(name: string, debit: string, credit: string, accountId = `id-${name}`) {
  return { RowType: 'Row', Cells: [{ Value: name, Attributes: [{ Id: 'account', Value: accountId }] }, { Value: debit }, { Value: credit }] };
}

function section(title: string, rows: unknown[]) {
  return { RowType: 'Section', Title: title, Rows: rows };
}

function summaryRow(label: string, total: string) {
  return { RowType: 'SummaryRow', Cells: [{ Value: label }, { Value: total }] };
}

function headerRow() {
  return { RowType: 'Header', Cells: [{ Value: 'Account' }, { Value: 'Debit' }, { Value: 'Credit' }] };
}

test('filterReportRows: no-op identity path when neither filter is requested (body returned unchanged)', () => {
  const body = reportBody([headerRow(), section('Bank', [accountRow('Checking', '100.00', '0.00'), summaryRow('Total Bank', '100.00')])]);
  assert.deepEqual(filterReportRows(body, {}), body);
});

test('filterReportRows: nonZeroOnly drops rows where every numeric column is 0.00, keeps Header and SummaryRow', () => {
  const body = reportBody([
    headerRow(),
    section('Bank', [
      accountRow('Checking', '100.00', '0.00'),
      accountRow('Empty Account', '0.00', '0.00'),
      summaryRow('Total Bank', '100.00'),
    ]),
  ]);
  const filtered = filterReportRows(body, { nonZeroOnly: true }) as { Reports: Array<{ Rows: Array<{ RowType?: string; Cells?: Array<{ Value?: string }> }> }> };
  const bankSection = filtered.Reports[0].Rows.find((r) => r.RowType === 'Section') as { Rows: Array<{ RowType?: string; Cells?: Array<{ Value?: string }> }> };
  const labels = bankSection.Rows.map((r) => r.Cells?.[0]?.Value);
  assert.ok(labels.includes('Checking'));
  assert.ok(!labels.includes('Empty Account'), 'a genuinely all-zero row must be dropped');
  assert.ok(labels.includes('Total Bank'), 'nonZeroOnly alone must NOT drop SummaryRow -- dropping zero rows never changes a true total');
  assert.ok(filtered.Reports[0].Rows.some((r) => r.RowType === 'Header'), 'Header must always survive');
});

test('filterReportRows: match keeps only rows whose label contains the string, CASE-INSENSITIVE', () => {
  const body = reportBody([section('Bank', [accountRow('Business CHECKING', '1.00', '0.00'), accountRow('Savings', '2.00', '0.00')])]);
  const filtered = filterReportRows(body, { match: ['checking'] }) as { Reports: Array<{ Rows: Array<{ Rows?: Array<{ Cells?: Array<{ Value?: string }> }> }> }> };
  const bankSection = filtered.Reports[0].Rows[0];
  assert.equal(bankSection.Rows?.length, 1);
  assert.equal(bankSection.Rows?.[0].Cells?.[0]?.Value, 'Business CHECKING');
});

test('filterReportRows: recurses into NESTED sections, dropping a Section entirely once every child is filtered out', () => {
  const body = reportBody([
    section('Revenue', [accountRow('Sales', '0.00', '500.00')]),
    section('Expenses', [accountRow('Rent', '200.00', '0.00')]),
  ]);
  const filtered = filterReportRows(body, { match: ['sales'] }) as { Reports: Array<{ Rows: Array<{ Title?: string }> }> };
  const sectionTitles = filtered.Reports[0].Rows.map((r) => r.Title);
  assert.deepEqual(sectionTitles, ['Revenue'], 'the Expenses section must be dropped entirely once its only row (Rent) is filtered out');
});

test('filterReportRows: SummaryRow is DROPPED (not kept stale) when match is active, but KEPT when only nonZeroOnly is active', () => {
  const withMatch = reportBody([section('Bank', [accountRow('Checking', '1.00', '0.00'), summaryRow('Total Bank', '999.00')])]);
  const filteredByMatch = filterReportRows(withMatch, { match: ['checking'] }) as { Reports: Array<{ Rows: Array<{ Rows?: Array<{ RowType?: string }> }> }> };
  const rowTypesAfterMatch = filteredByMatch.Reports[0].Rows[0].Rows?.map((r) => r.RowType);
  assert.ok(!rowTypesAfterMatch?.includes('SummaryRow'), 'match subsets accounts, so a kept SummaryRow would show a stale, unfiltered total');

  const withNonZeroOnly = reportBody([section('Bank', [accountRow('Checking', '1.00', '0.00'), summaryRow('Total Bank', '1.00')])]);
  const filteredByNonZero = filterReportRows(withNonZeroOnly, { nonZeroOnly: true }) as { Reports: Array<{ Rows: Array<{ Rows?: Array<{ RowType?: string }> }> }> };
  const rowTypesAfterNonZero = filteredByNonZero.Reports[0].Rows[0].Rows?.map((r) => r.RowType);
  assert.ok(rowTypesAfterNonZero?.includes('SummaryRow'), 'nonZeroOnly alone never changes a true total, so SummaryRow stays');
});

test('filterReportRows: an unrecognized/empty body shape is returned unchanged rather than throwing', () => {
  assert.deepEqual(filterReportRows(null, { nonZeroOnly: true }), null);
  assert.deepEqual(filterReportRows({}, { match: ['x'] }), {});
  assert.deepEqual(filterReportRows({ Reports: [] }, { nonZeroOnly: true }), { Reports: [] });
});

// -------------------------------------------------------------------------------------------
// handleXeroAttachmentUpload -- handler-level tests (Copilot review, 2026-07-30: "none executes
// this handler with a stubbed uploader. Consequently they do not prove the safety-critical claim
// that a mismatch returns before xeroUploadAttachment is called, nor that a match reaches the
// uploader"). Deps-injected (see the handler's optional 3rd `deps` param), mirroring gl-assemble
// .test.ts's pattern -- no real Cosmos or Xero.
// -------------------------------------------------------------------------------------------

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

function liveTokenState() {
  return {
    doc: buildTokenDoc({
      org: 'otchealth',
      refreshToken: 'rt-live',
      accessToken: 'at-live',
      expiresInSeconds: 1800,
      tenantId: 'tenant-1',
      tenantName: 'OTCHealth Inc.',
      bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH),
    }),
    etag: 'etag-1',
  };
}

test('handleXeroAttachmentUpload: a truncation mismatch (expected_bytes) refuses BEFORE any network call is made', async () => {
  const state = liveTokenState();
  const deps = {
    fetchImpl: (async (url: unknown) => {
      throw new Error(`UNEXPECTED network call to ${String(url)} -- the integrity check must refuse before xeroUploadAttachment is ever reached`);
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentUpload(
    {
      org: 'otchealth',
      endpoint: 'ManualJournals',
      guid: 'journal-1',
      fileName: 'statement.pdf',
      contentBase64: Buffer.from('short truncated content').toString('base64'),
      mimeType: 'application/pdf',
      expected_bytes: 999999, // deliberately wrong
    },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string; body: unknown };
  assert.equal(data.error, 'truncated_payload');
  assert.equal(data.body, null);
  assert.match(result.summary ?? '', /REFUSED \(not uploaded\)/);
});

test('handleXeroAttachmentUpload: a genuinely MATCHING payload reaches xeroUploadAttachment and returns its response', async () => {
  const state = liveTokenState();
  const content = Buffer.from('the real, complete file content');
  const expectedSha256 = createHash('sha256').update(content).digest('hex');
  let uploadCalled = false;
  const deps = {
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.includes('/Attachments/')) {
        uploadCalled = true;
        assert.equal(init?.method, 'PUT');
        return new Response(JSON.stringify({ Attachments: [{ AttachmentID: 'att-1', FileName: 'statement.pdf' }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called -- the seeded token is already live'); }) as never,
    create: (async () => { throw new Error('create should never be called -- the seeded token is already live'); }) as never,
  };
  const result = await handleXeroAttachmentUpload(
    {
      org: 'otchealth',
      endpoint: 'ManualJournals',
      guid: 'journal-1',
      fileName: 'statement.pdf',
      contentBase64: content.toString('base64'),
      mimeType: 'application/pdf',
      expected_bytes: content.length,
      expected_sha256: expectedSha256,
    },
    fakeCtx('cfo', false), // dry_run:false -- a real (stubbed) upload attempt
    deps,
  );
  assert.ok(uploadCalled, 'xeroUploadAttachment must actually be invoked for a matching payload');
  const data = result.data as { error?: string; body: unknown; sha256?: string };
  assert.equal(data.error, undefined);
  assert.equal(data.sha256, expectedSha256);
  assert.deepEqual(data.body, { Attachments: [{ AttachmentID: 'att-1', FileName: 'statement.pdf' }] });
});

test('handleXeroAttachmentUpload: dry_run also refuses before any network call, even with matching integrity values', async () => {
  const deps = {
    fetchImpl: (async (url: unknown) => {
      throw new Error(`UNEXPECTED network call to ${String(url)} in dry_run mode`);
    }) as typeof fetch,
    read: (async () => { throw new Error('read should never be called in dry_run'); }) as never,
    replace: (async () => { throw new Error('replace should never be called in dry_run'); }) as never,
    create: (async () => { throw new Error('create should never be called in dry_run'); }) as never,
  };
  const content = Buffer.from('dry run content');
  const result = await handleXeroAttachmentUpload(
    {
      org: 'otchealth',
      endpoint: 'ManualJournals',
      guid: 'journal-1',
      fileName: 'statement.pdf',
      contentBase64: content.toString('base64'),
      mimeType: 'application/pdf',
    },
    fakeCtx('cfo', true), // dry_run:true
    deps,
  );
  const data = result.data as { error?: string; body: unknown };
  assert.equal(data.error, 'dry_run');
  assert.equal(data.body, null);
});

// -------------------------------------------------------------------------------------------
// handleXeroAttachmentContent -- handler-level tests, mirroring handleXeroAttachmentUpload's
// pattern above: deps-injected (no real Cosmos or Xero), each distinct outcome asserted by name so
// none can silently collapse into another (the failure class this tool exists to prevent).
// -------------------------------------------------------------------------------------------

test('handleXeroAttachmentContent: neither fileName nor attachmentId -> identifier_required, no network call', async () => {
  const deps = {
    fetchImpl: (async (url: unknown) => {
      throw new Error(`UNEXPECTED network call to ${String(url)} -- must refuse before ever calling Xero`);
    }) as typeof fetch,
    read: (async () => { throw new Error('read should never be called'); }) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'ManualJournals', guid: 'journal-1' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string; contentBase64: unknown; textContent: unknown };
  assert.equal(data.error, 'identifier_required');
  assert.equal(data.contentBase64, null);
  assert.equal(data.textContent, null);
});

test('handleXeroAttachmentContent: BOTH fileName and attachmentId -> ambiguous_identifier, no network call', async () => {
  const deps = {
    fetchImpl: (async (url: unknown) => {
      throw new Error(`UNEXPECTED network call to ${String(url)} -- must refuse before ever calling Xero`);
    }) as typeof fetch,
    read: (async () => { throw new Error('read should never be called'); }) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'ManualJournals', guid: 'journal-1', fileName: 'a.pdf', attachmentId: 'att-1' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string };
  assert.equal(data.error, 'ambiguous_identifier');
});

test('handleXeroAttachmentContent: binary content -> contentBase64 populated, textContent null', async () => {
  const state = liveTokenState();
  const original = Buffer.from('%PDF-1.4 fake pdf bytes with a NUL \x00 inside');
  const deps = {
    fetchImpl: (async (url: unknown) => {
      const u = new URL(String(url));
      assert.ok(u.pathname.endsWith('/ManualJournals/journal-1/Attachments/att-1'));
      return new Response(original, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called -- the seeded token is already live'); }) as never,
    create: (async () => { throw new Error('create should never be called -- the seeded token is already live'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'ManualJournals', guid: 'journal-1', attachmentId: 'att-1' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string; contentBase64: string | null; textContent: string | null; mimeType: string; bytes: number; sha256: string };
  assert.equal(data.error, undefined);
  assert.equal(data.textContent, null, 'binary content must not be presented as text');
  assert.equal(data.contentBase64, original.toString('base64'));
  assert.equal(Buffer.from(data.contentBase64 as string, 'base64').equals(original), true, 'round-trips to the exact original bytes');
  assert.equal(data.mimeType, 'application/pdf');
  assert.equal(data.bytes, original.length);
  assert.equal(data.sha256, createHash('sha256').update(original).digest('hex'));
});

test('handleXeroAttachmentContent: genuinely TEXT content -> textContent populated, contentBase64 null (never both, avoids doubling an already-capped payload)', async () => {
  const state = liveTokenState();
  const original = Buffer.from('Date,Description,Amount\n2022-01-31,Reclass,1500.50\n', 'utf8');
  const deps = {
    fetchImpl: (async () => new Response(original, { status: 200, headers: { 'Content-Type': 'text/csv' } })) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'ManualJournals', guid: 'journal-1', fileName: 'workpaper.csv' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string; contentBase64: string | null; textContent: string | null; textDecodeRefused?: boolean };
  assert.equal(data.error, undefined);
  assert.equal(data.contentBase64, null, 'a genuinely text file must not ALSO be duplicated as base64 (would double the response size near the cap)');
  assert.equal(data.textContent, original.toString('utf8'));
  assert.equal(data.textDecodeRefused, undefined, 'a lossless decode never carries the refusal flag');
  // FIX 2 (2026-08-18): the "byte-for-byte" claim is only allowed once the round-trip has actually
  // proven it -- assert the summary makes that claim, and that it names the round-trip as the proof
  // (not merely "genuinely text" on its own, which would be the pre-fix, unproven claim).
  assert.match(result.summary ?? '', /byte-for-byte/);
  assert.match(result.summary ?? '', /round-trip/);
});

test('handleXeroAttachmentContent: a text/* Content-Type whose bytes are NOT valid UTF-8 (e.g. a Windows-1252 export) is returned as contentBase64, with the refusal reason STRUCTURED in `data` (not only prose in `summary`)', async () => {
  const state = liveTokenState();
  // "caf" + 0xE9 (Windows-1252 for e-acute) + newline. 0xE9 followed by a non-continuation byte
  // (0x0a) is an INVALID UTF-8 sequence -- Buffer#toString('utf8') would silently substitute U+FFFD
  // for it rather than throwing, which is exactly why eligibility-by-Content-Type alone is not proof:
  // this is the real-world case (an older financial CSV/TXT export) the round-trip exists to catch.
  const cp1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  const deps = {
    fetchImpl: (async () => new Response(cp1252, { status: 200, headers: { 'Content-Type': 'text/plain' } })) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'ManualJournals', guid: 'journal-1', fileName: 'legacy-export.txt' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string; textContent: string | null; contentBase64: string | null; textDecodeRefused?: boolean };
  assert.equal(data.error, undefined, 'this is not one of the http-status error kinds -- it is still a successful fetch, just an unprovable text decode');
  assert.equal(data.textContent, null, 'must NEVER hand back a lossy U+FFFD-substituted rendering as though it were the real text');
  assert.equal(data.contentBase64, cp1252.toString('base64'), 'falls back to byte-exact base64 instead');
  assert.equal(Buffer.from(data.contentBase64 as string, 'base64').equals(cp1252), true, 'round-trips to the exact original (undecoded) bytes');
  assert.equal(data.textDecodeRefused, true, 'the refusal reason is a STRUCTURED field in `data` -- clients in this fleet read structured fields, a discriminator that lives only in `summary` prose is invisible to them');
  assert.match(result.summary ?? '', /not valid UTF-8/i);
});

test('handleXeroAttachmentContent: a concrete non-textual Content-Type (e.g. image/tiff) is NEVER treated as text, even when looksBinary alone would say "not binary" -- this is failure mode (a): looksBinary only knows 5 magic-number families + a NUL scan, but this tool serves ANY Xero-attached format', async () => {
  const state = liveTokenState();
  // Deliberately NO NUL byte and NO magic number looksBinary recognizes anywhere in these bytes --
  // proves the fix does not rely on looksBinary alone for a CONCRETE, declared non-textual
  // Content-Type. (A real TIFF header actually starts 'II*\0', which DOES contain a NUL -- so this
  // synthetic buffer is the harder case: the OLD looksBinary-only code would have wrongly classified
  // exactly this as text, which is the point of the test.)
  const tiffLike = Buffer.from(Array.from({ length: 200 }, (_, i) => 0x41 + (i % 26)));
  assert.equal(tiffLike.includes(0), false, 'sanity: no NUL byte in this fixture');
  const deps = {
    fetchImpl: (async () => new Response(tiffLike, { status: 200, headers: { 'Content-Type': 'image/tiff' } })) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'ManualJournals', guid: 'journal-1', fileName: 'scan.tiff' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { textContent: string | null; contentBase64: string | null; textDecodeRefused?: boolean };
  assert.equal(data.textContent, null, 'a declared image/tiff Content-Type must never be decoded as text, regardless of what looksBinary alone would say');
  assert.equal(data.contentBase64, tiffLike.toString('base64'));
  assert.equal(data.textDecodeRefused, undefined, 'this file never LOOKED text-eligible in the first place -- textDecodeRefused is for the OTHER failure mode (declared-textual but not valid UTF-8), not this one');
});

test('handleXeroAttachmentContent: FIX 3 -- an input mimeType hint threads through to the outbound Accept header', async () => {
  const state = liveTokenState();
  let acceptSeen: string | null = null;
  const deps = {
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      acceptSeen = (init?.headers as Record<string, string> | undefined)?.Accept ?? null;
      return new Response(Buffer.from('ok'), { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'Invoices', guid: 'inv-1', attachmentId: 'att-1', mimeType: 'application/pdf' },
    fakeCtx('cfo', false),
    deps,
  );
  assert.equal(acceptSeen, 'application/pdf, */*', 'the tool input mimeType hint must reach the wire, ahead of the wildcard');
});

test('handleXeroAttachmentContent: not_found and forbidden map to DISTINCT error codes -- never conflated', async () => {
  const state = liveTokenState();
  async function run(status: number) {
    const deps = {
      fetchImpl: (async () => new Response(JSON.stringify({ Message: 'x' }), { status })) as typeof fetch,
      read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
      replace: (async () => { throw new Error('replace should never be called'); }) as never,
      create: (async () => { throw new Error('create should never be called'); }) as never,
    };
    return handleXeroAttachmentContent(
      { org: 'otchealth', endpoint: 'Invoices', guid: 'inv-1', attachmentId: 'att-1' },
      fakeCtx('cfo', false),
      deps,
    );
  }
  const notFound = (await run(404)).data as { error?: string; http_status?: number };
  const forbidden = (await run(403)).data as { error?: string; http_status?: number };
  assert.equal(notFound.error, 'not_found');
  assert.equal(notFound.http_status, 404);
  assert.equal(forbidden.error, 'forbidden');
  assert.equal(forbidden.http_status, 403);
  assert.notEqual(notFound.error, forbidden.error, 'a 403 must never be reported the same way as a 404');
});

test('handleXeroAttachmentContent: too_large -> nothing downloaded/returned, cap + real size surfaced, distinct from every other error', async () => {
  const state = liveTokenState();
  const deps = {
    fetchImpl: (async () => new Response(Buffer.alloc(10), { status: 200, headers: { 'Content-Length': '99999999', 'Content-Type': 'application/pdf' } })) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroAttachmentContent(
    { org: 'otchealth', endpoint: 'Invoices', guid: 'inv-1', attachmentId: 'huge' },
    fakeCtx('cfo', false),
    deps,
  );
  const data = result.data as { error?: string; contentBase64: unknown; textContent: unknown; cap_bytes?: number };
  assert.equal(data.error, 'content_too_large');
  assert.equal(data.contentBase64, null);
  assert.equal(data.textContent, null);
  assert.equal(data.cap_bytes, 1024 * 1024);
  assert.match(result.summary ?? '', /REFUSED/);
});

// -------------------------------------------------------------------------------------------
// handleXeroRequest -- handler-level tests for the RESIDUAL half of FND-20260724-f6df (found
// 2026-08-28): the dedicated xero_attachment_upload tool was fixed to send raw file bytes, but the
// UNIVERSAL xero_request tool could still reach the identical Attachments sub-resource with a JSON
// body -- xeroRequest() (client.ts) always JSON.stringify()s its body and always sends
// Content-Type: application/json, with zero awareness of the path. See
// client.test.ts's "xeroRequest: MECHANISM" test for proof of that underlying behavior, and
// write-guard.test.ts's attachmentWriteRefusal tests for the pure detection logic this handler now
// consults. handleXeroRequest itself was extracted standalone from an inline registerTool handler
// specifically so this wiring is directly provable -- mirroring handleXeroAttachmentUpload's own
// extraction rationale (a stubbed fetch that throws on ANY call demonstrates the refusal path makes
// zero network I/O).
// -------------------------------------------------------------------------------------------

function throwingFetchDeps(state: ReturnType<typeof liveTokenState>) {
  return {
    fetchImpl: (async (url: unknown) => {
      throw new Error(`UNEXPECTED network call to ${String(url)} -- the Attachments guard must refuse before xeroRequest is ever reached`);
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
}

test('handleXeroRequest: a POST to an Attachments sub-resource is REFUSED before any network call (dry_run:false)', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/ManualJournals/journal-1/Attachments/statement.pdf',
      body: { notTheRealFileBytes: true },
    },
    fakeCtx('cfo', false),
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string; body: unknown };
  assert.equal(data.error, 'use_xero_attachment_upload');
  assert.equal(data.body, null);
  assert.match(result.summary ?? '', /REFUSED/);
  assert.match(result.summary ?? '', /xero_attachment_upload/);
});

test('handleXeroRequest: a PUT to an Attachments sub-resource is REFUSED the same way', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    { org: 'otchealth', method: 'PUT', path: '/Invoices/inv-1/Attachments/receipt.png', body: { x: 1 } },
    fakeCtx('cfo', false),
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string };
  assert.equal(data.error, 'use_xero_attachment_upload');
});

test('handleXeroRequest: the Attachments refusal fires under dry_run:true TOO -- a dry run must report the REAL refusal, not a misleading "would write"', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    { org: 'otchealth', method: 'POST', path: '/ManualJournals/journal-1/Attachments/statement.pdf', body: {} },
    fakeCtx('cfo', true), // dry_run:true
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string };
  assert.equal(data.error, 'use_xero_attachment_upload', 'must NOT be the generic "dry_run" code -- the attachment guard runs first and is the real reason this call would fail');
});

test('handleXeroRequest: a DELETE to an Attachments sub-resource is NOT gated by the attachment guard (no body is sent, so the JSON-vs-bytes mismatch cannot occur) and proceeds to the normal write path', async () => {
  const state = liveTokenState();
  let deleteCalled = false;
  const deps = {
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url));
      assert.ok(u.pathname.endsWith('/Invoices/inv-1/Attachments/old-file.pdf'));
      assert.equal(init?.method, 'DELETE');
      deleteCalled = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroRequest(
    { org: 'otchealth', method: 'DELETE', path: '/Invoices/inv-1/Attachments/old-file.pdf' },
    fakeCtx('cfo', false),
    deps,
  );
  assert.ok(deleteCalled, 'a DELETE against an Attachments path must still reach xeroRequest -- only POST/PUT are gated');
  const data = result.data as { error?: string };
  assert.equal(data.error, undefined);
});

test('handleXeroRequest: an ORDINARY (non-Attachments) write is UNCHANGED by the extraction -- dry_run still previews without any network call', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    { org: 'otchealth', method: 'POST', path: '/Contacts', body: { Contacts: [{ Name: 'Test Co' }] } },
    fakeCtx('cfo', true),
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string };
  assert.equal(data.error, 'dry_run');
});

test('handleXeroRequest: an ORDINARY (non-Attachments) write still enforces the pre-existing account-code write-guard', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/Invoices',
      // An Invoice LineItems violation must be refused BEFORE the duplicate-create probe even runs,
      // so throwingFetchDeps (which throws on any network call) proves it never reached that far.
      // (FND-20260902-3ab8 extended this same guard to ManualJournals' JournalLines and to
      // BankTransfers/Payments' bare Account-reference fields -- see write-guard.test.ts and the
      // dedicated handleXeroRequest tests below for those.)
      body: { Invoices: [{ Reference: 'INV-1', LineItems: [{ LineAmount: 5, AccountCode: '1251' }] }] },
    },
    fakeCtx('cfo', false),
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string };
  assert.equal(data.error, 'account_code_not_permitted', 'the pre-existing cross-org account-code guard must survive the extraction unchanged');
});

// ── FND-20260902-3ab8: handler-level wiring proof that the guard's coverage extension actually
// reaches handleXeroRequest, not just the pure write-guard.ts unit tests above. ───────────────────

test('handleXeroRequest: a ManualJournal write coded by AccountCode on JournalLines is refused BEFORE any network call (closes FND-20260902-3ab8)', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/ManualJournals',
      body: {
        ManualJournals: [
          {
            Narration: 'Reclass derivative liability, note 4',
            Date: '2022-01-31',
            JournalLines: [
              { LineAmount: 1500.5, AccountCode: '1251' },
              { LineAmount: -1500.5, AccountCode: '2000' },
            ],
          },
        ],
      },
    },
    fakeCtx('cfo', false),
    throwingFetchDeps(state), // proves the refusal fires before the duplicate-create probe's xeroGet call
  );
  const data = result.data as { error?: string };
  assert.equal(
    data.error,
    'account_code_not_permitted',
    'a ManualJournal coded by AccountCode on JournalLines must be refused, the same as an Invoice coded on LineItems',
  );
});

test('handleXeroRequest: dry_run does NOT mask the ManualJournal JournalLines account-code refusal -- the guard runs before the dry-run return, same as every other write-guard check', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/ManualJournals',
      body: {
        ManualJournals: [
          { Narration: 'n', Date: '2022-01-31', JournalLines: [{ LineAmount: 100, AccountCode: '1251' }] },
        ],
      },
    },
    fakeCtx('cfo', true), // dry_run: true
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string };
  assert.equal(
    data.error,
    'account_code_not_permitted',
    'dry_run must report the REAL refusal, not a misleading "would write" or the generic dry_run marker',
  );
});

test('handleXeroRequest: a BankTransfer whose legs are identified by Code (not AccountID) is refused BEFORE any network call', async () => {
  const state = liveTokenState();
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/BankTransfers',
      body: {
        BankTransfers: [{ FromBankAccount: { Code: '090' }, ToBankAccount: { Code: '091' }, Amount: 500, Date: '2026-01-01' }],
      },
    },
    fakeCtx('cfo', false),
    throwingFetchDeps(state),
  );
  const data = result.data as { error?: string };
  assert.equal(data.error, 'account_code_not_permitted', 'a BankTransfer has no LineItems at all -- FromBankAccount/ToBankAccount are its only account identity, and must be guarded');
});

test('handleXeroRequest: a ManualJournal write identified by AccountID (already mapped) reaches xeroRequest cleanly -- no false positive from the extended guard', async () => {
  const state = liveTokenState();
  let requestCalled = false;
  const deps = {
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/ManualJournals') && init?.method === 'POST') {
        requestCalled = true;
        return new Response(JSON.stringify({ ManualJournals: [{ ManualJournalID: 'mj-2' }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/ManualJournals',
      allow_duplicate: true, // isolates the account-code guard from the duplicate-create probe, same pattern as the existing clean-write test above
      body: {
        ManualJournals: [
          {
            Narration: 'n',
            Date: '2026-01-01',
            JournalLines: [
              { LineAmount: 5, AccountID: 'ha-acct-guid-1' },
              { LineAmount: -5, AccountCode: '2000', AccountID: 'ha-acct-guid-2' },
            ],
          },
        ],
      },
    },
    fakeCtx('cfo', false),
    deps,
  );
  assert.ok(requestCalled, 'an AccountID-mapped ManualJournal must still reach xeroRequest');
  const data = result.data as { error?: string };
  assert.equal(data.error, undefined);
});

test('handleXeroRequest: an ORDINARY (non-Attachments) write with no duplicate-detection blockers reaches xeroRequest and returns its response', async () => {
  const state = liveTokenState();
  let requestCalled = false;
  const deps = {
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/ManualJournals') && init?.method === 'POST') {
        requestCalled = true;
        return new Response(JSON.stringify({ ManualJournals: [{ ManualJournalID: 'mj-1' }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called'); }) as never,
    create: (async () => { throw new Error('create should never be called'); }) as never,
  };
  const result = await handleXeroRequest(
    {
      org: 'otchealth',
      method: 'POST',
      path: '/ManualJournals',
      allow_duplicate: true, // skips the existence-probe network call so this test isolates the Attachments guard from write-guard's OWN (already covered) probe logic
      body: { ManualJournals: [{ Narration: 'n', Date: '2026-01-01', JournalLines: [{ LineAmount: 5 }] }] },
    },
    fakeCtx('cfo', false),
    deps,
  );
  assert.ok(requestCalled, 'a clean, non-Attachments write must still reach xeroRequest');
  const data = result.data as { error?: string; body: unknown };
  assert.equal(data.error, undefined);
  assert.deepEqual(data.body, { ManualJournals: [{ ManualJournalID: 'mj-1' }] });
});
