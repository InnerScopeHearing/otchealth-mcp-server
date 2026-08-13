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
    COSMOS_ENDPOINT: 'https://test.documents.azure.com',
    COSMOS_DB: 'test',
    COSMOS_KEY: Buffer.from('test-key').toString('base64'),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const { checkAttachmentPayloadIntegrity, filterReportRows, handleXeroAttachmentUpload } = await import('./tools.js');
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
