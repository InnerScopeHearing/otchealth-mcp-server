import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Same preamble as client.test.ts -- satisfies loadEnv()'s required vars before assembleGl's
// integration tests (below) transitively call it via xeroGet -> getOrgAccess.
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

const {
  monthEndIso,
  monthEndDates,
  parseTrialBalanceRows,
  sumManualJournalsByAccount,
  sumLineItemsByAccount,
  fetchAllPaged,
  MAX_PAGES_PER_ENDPOINT,
  assembleGl,
  firstDayOfMonth,
  resolveGlAssembleBudgetMs,
} = await import('./gl-assemble.js');
const { buildTokenDoc, bootstrapHash } = await import('./client.js');

// -------------------------------------------------------------------------------------------
// monthEndIso / monthEndDates
// -------------------------------------------------------------------------------------------

test('monthEndIso: last day of a 31-day, 30-day, and leap-Feb month', () => {
  assert.equal(monthEndIso(2026, 0), '2026-01-31'); // January
  assert.equal(monthEndIso(2026, 3), '2026-04-30'); // April
  assert.equal(monthEndIso(2028, 1), '2028-02-29'); // leap year Feb
  assert.equal(monthEndIso(2026, 1), '2026-02-28'); // non-leap Feb
});

test('monthEndDates: one calendar month returns [leading boundary, monthEnd] — 2 entries', () => {
  const dates = monthEndDates('2026-03-05', '2026-03-20');
  assert.deepEqual(dates, ['2026-02-28', '2026-03-31']);
});

test('monthEndDates: a full year returns leading boundary + 12 month-ends = 13 entries, in order', () => {
  const dates = monthEndDates('2026-01-01', '2026-12-31');
  assert.equal(dates.length, 13);
  assert.equal(dates[0], '2025-12-31'); // leading boundary: the month BEFORE January
  assert.equal(dates[1], '2026-01-31');
  assert.equal(dates[12], '2026-12-31');
});

test('monthEndDates: leading boundary correctly rolls back across a year boundary (January -> prior December)', () => {
  const dates = monthEndDates('2026-01-15', '2026-01-20');
  assert.deepEqual(dates, ['2025-12-31', '2026-01-31']);
});

test('monthEndDates: throws when to is before from', () => {
  assert.throws(() => monthEndDates('2026-06-01', '2026-01-01'));
});

test('monthEndDates: throws on an unparseable date rather than silently producing garbage', () => {
  assert.throws(() => monthEndDates('not-a-date', '2026-01-01'));
});

// -------------------------------------------------------------------------------------------
// parseTrialBalanceRows
// -------------------------------------------------------------------------------------------

function tbReportBody(rows: unknown[]): unknown {
  return { Reports: [{ ReportID: 'TrialBalance', Rows: rows }] };
}

/** A 5-cell TrialBalance row: [Account, Debit(period), Credit(period), YTD Debit, YTD Credit]. */
function row5(name: string, debit: string, credit: string, ytdDebit: string, ytdCredit: string, accountId?: string) {
  const cells: Array<{ Value?: string; Attributes?: Array<{ Id: string; Value: string }> }> = [
    accountId ? { Value: name, Attributes: [{ Id: 'account', Value: accountId }] } : { Value: name },
    { Value: debit },
    { Value: credit },
    { Value: ytdDebit },
    { Value: ytdCredit },
  ];
  return { RowType: 'Row', Cells: cells };
}

test('parseTrialBalanceRows: flattens a Section > Row structure, keeping account id + period debit/credit + YTD', () => {
  const body = tbReportBody([
    { RowType: 'Header', Cells: [{ Value: 'Account' }, { Value: 'Debit' }, { Value: 'Credit' }] },
    {
      RowType: 'Section',
      Title: 'Revenue',
      Rows: [row5('Sales', '0.00', '1234.56', '0.00', '9999.00', 'acc-guid-1')],
    },
    {
      RowType: 'Section',
      Title: 'Bank',
      Rows: [
        row5('Business Checking', '5000.00', '0.00', '5000.00', '0.00', 'acc-guid-2'),
        { RowType: 'SummaryRow', Cells: [{ Value: 'Total Bank' }, { Value: '5000.00' }, { Value: '0.00' }] },
      ],
    },
  ]);
  const parsed = parseTrialBalanceRows(body);
  assert.equal(parsed.rows.length, 2); // the SummaryRow is skipped
  assert.equal(parsed.unresolvedRowCount, 0);
  assert.deepEqual(parsed.rows[0], { accountId: 'acc-guid-1', name: 'Sales', debit: 0, credit: 1234.56, ytdDebit: 0, ytdCredit: 9999 });
  assert.deepEqual(parsed.rows[1], { accountId: 'acc-guid-2', name: 'Business Checking', debit: 5000, credit: 0, ytdDebit: 5000, ytdCredit: 0 });
});

test('parseTrialBalanceRows: descends into a nested row NOT typed "Section" (only condition is that it carries child Rows)', () => {
  // Simulates the plausible parser gap flagged by the CFO's live acceptance test: a sub-total-with-
  // detail row that Xero emits under some RowType other than "Section".
  const body = tbReportBody([
    {
      RowType: 'Row', // deliberately NOT "Section"
      Title: 'Equity',
      Rows: [row5('Retained Earnings', '0.00', '7365719.00', '0.00', '7365719.00', 'acc-3130')],
    },
  ]);
  const parsed = parseTrialBalanceRows(body);
  assert.equal(parsed.rows.length, 1, 'must still descend into and capture a nested row even when the parent is not typed Section');
  assert.equal(parsed.rows[0].accountId, 'acc-3130');
  assert.equal(parsed.rows[0].credit, 7365719);
});

test('REGRESSION (Copilot, gl-assemble.ts): a container row that ALSO carries its own Cells (a subtotal-with-detail row) is never ALSO parsed as a leaf account -- only its children are', () => {
  const body = tbReportBody([
    {
      RowType: 'Row', // a subtotal row: has BOTH a label+amount pair AND nested detail rows
      Cells: [{ Value: 'Total Equity' }, { Value: '7365719.00' }, { Value: '0.00' }, { Value: '7365719.00' }, { Value: '0.00' }],
      Rows: [row5('Retained Earnings', '7365719.00', '0.00', '7365719.00', '0.00', 'acc-3130')],
    },
  ]);
  const parsed = parseTrialBalanceRows(body);
  assert.equal(parsed.rows.length, 1, 'only the child account is captured -- the container must not ALSO emit a synthetic name:"Total Equity" account for itself');
  assert.equal(parsed.rows[0].accountId, 'acc-3130');
});

test('parseTrialBalanceRows: falls back to a name-derived key when no "account" attribute is present', () => {
  const body = tbReportBody([
    { RowType: 'Section', Rows: [row5('Mystery Account', '10.00', '0.00', '10.00', '0.00')] },
  ]);
  const parsed = parseTrialBalanceRows(body);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].accountId, 'name:Mystery Account');
});

test('parseTrialBalanceRows: a row with NEITHER an account GUID NOR a name is dropped but COUNTED, not silently lost', () => {
  const body = tbReportBody([
    {
      RowType: 'Section',
      Rows: [
        row5('Cash', '100.00', '0.00', '100.00', '0.00', 'acc-1'),
        { RowType: 'Row', Cells: [{ Value: '' }, { Value: '50.00' }, { Value: '0.00' }] }, // unresolvable
      ],
    },
  ]);
  const parsed = parseTrialBalanceRows(body);
  assert.equal(parsed.rows.length, 1, 'the resolvable row is kept');
  assert.equal(parsed.unresolvedRowCount, 1, 'the unresolvable row is counted, not silently discarded');
});

test('parseTrialBalanceRows: an empty/unrecognized shape returns {rows: [], unresolvedRowCount: 0} rather than throwing', () => {
  assert.deepEqual(parseTrialBalanceRows(null), { rows: [], unresolvedRowCount: 0 });
  assert.deepEqual(parseTrialBalanceRows({}), { rows: [], unresolvedRowCount: 0 });
  assert.deepEqual(parseTrialBalanceRows({ Reports: [] }), { rows: [], unresolvedRowCount: 0 });
  assert.deepEqual(parseTrialBalanceRows({ Reports: [{}] }), { rows: [], unresolvedRowCount: 0 });
});

// -------------------------------------------------------------------------------------------
// sumManualJournalsByAccount
// -------------------------------------------------------------------------------------------

test('sumManualJournalsByAccount: sums signed LineAmount by AccountID across multiple journals', () => {
  const body = {
    ManualJournals: [
      { Date: '2026-01-05', JournalLines: [{ AccountID: 'a1', LineAmount: 100 }, { AccountID: 'a2', LineAmount: -100 }] },
      { Date: '2026-01-20', JournalLines: [{ AccountID: 'a1', LineAmount: 50 }] },
    ],
  };
  const sums = sumManualJournalsByAccount(body);
  assert.equal(sums.get('a1'), 150);
  assert.equal(sums.get('a2'), -100);
});

test('sumManualJournalsByAccount: falls back to a code-derived key when AccountID is absent', () => {
  const body = { ManualJournals: [{ JournalLines: [{ AccountCode: '400', LineAmount: 25 }] }] };
  const sums = sumManualJournalsByAccount(body);
  assert.equal(sums.get('code:400'), 25);
});

test('sumManualJournalsByAccount: a malformed/empty body returns an empty map, not a throw', () => {
  assert.equal(sumManualJournalsByAccount(null).size, 0);
  assert.equal(sumManualJournalsByAccount({}).size, 0);
});

// -------------------------------------------------------------------------------------------
// sumLineItemsByAccount
// -------------------------------------------------------------------------------------------

test('sumLineItemsByAccount: sums the ABSOLUTE value of LineAmount by account (gross, unsigned by design)', () => {
  const docs = [{ LineItems: [{ AccountID: 'a1', LineAmount: -50 }, { AccountID: 'a1', LineAmount: 30 }] }];
  const sums = sumLineItemsByAccount(docs);
  assert.equal(sums.get('a1'), 80); // |-50| + |30|, gross activity — never netted, see module doc comment
});

test('sumLineItemsByAccount: skips a line item with no AccountID/AccountCode', () => {
  const docs = [{ LineItems: [{ LineAmount: 10 }] }];
  const sums = sumLineItemsByAccount(docs);
  assert.equal(sums.size, 0);
});

// -------------------------------------------------------------------------------------------
// assembleGl — orchestrator integration tests. Deps-injected: no real Cosmos or Xero.
// -------------------------------------------------------------------------------------------

function liveTokenState() {
  const doc = buildTokenDoc({
    org: 'otchealth',
    refreshToken: 'rt-live',
    accessToken: 'at-live',
    expiresInSeconds: 1800,
    tenantId: 'tenant-1',
    tenantName: 'OTCHealth Inc.',
    bootstrapHash: bootstrapHash(process.env.XERO_RT_OTCHEALTH),
  });
  return { doc, etag: 'etag-1' };
}

// -------------------------------------------------------------------------------------------
// fetchAllPaged -- the shape-anomaly-vs-legitimate-empty-page distinction (silent-truncation fix)
// -------------------------------------------------------------------------------------------

/** Stubs one xeroGet-backed endpoint: `pages[i]` is the raw JSON body returned for `page=i+1`.
 * Reuses the same live-token bootstrapping as the assembleGl integration tests below. */
function makePagedDeps(pages: unknown[]) {
  const state = liveTokenState();
  return {
    fetchImpl: (async (url: string | URL) => {
      const u = new URL(String(url));
      const page = Number(u.searchParams.get('page'));
      const body = pages[page - 1];
      if (body === undefined) throw new Error(`no stub for page ${page}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called -- the seeded token is already live'); }) as never,
    create: (async () => { throw new Error('create should never be called -- the seeded token is already live'); }) as never,
  };
}

test('fetchAllPaged: a genuinely empty array is a legitimate last page -- no shapeAnomaly, not truncated', async () => {
  const deps = makePagedDeps([{ ManualJournals: [] }]);
  const res = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', deps);
  assert.deepEqual(res.items, []);
  assert.equal(res.truncated, false);
  assert.equal(res.shapeAnomaly, undefined);
});

// --- THE HEADLINE REGRESSION: the bare `if (!Array.isArray(arr) || arr.length === 0) break;`
// treated a MISSING/malformed array key exactly like a legitimate empty last page: same silent
// `break`, `truncated` never set, no caveat raised anywhere up the call chain. assembleGl would
// then report a clean, complete-looking result (caveats: []) that was actually silently short --
// on a general-ledger reconciliation for a public company. These two tests are the counterfactual
// proof: reverting fetchAllPaged's shape check back to the old bare `break` makes BOTH of them fail
// (shapeAnomaly would be undefined and truncated would be false in both cases). Verified by hand
// against the pre-fix code during this change.

test('REGRESSION: the arrayKey is entirely MISSING from an otherwise-2xx body -- a shape anomaly, NOT an empty last page', async () => {
  const deps = makePagedDeps([{ SomeUnexpectedField: [] }]); // no "ManualJournals" key at all
  const res = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', deps);
  assert.equal(res.truncated, true, 'a shape anomaly must mark the result incomplete, the same signal a real page-cap hit uses');
  assert.ok(res.shapeAnomaly, 'the anomaly must be surfaced, not silently swallowed');
  assert.match(res.shapeAnomaly!, /\/ManualJournals page 1/, 'the caveat must name the endpoint and the exact page it happened on');
  assert.match(res.shapeAnomaly!, /got missing/);
  assert.deepEqual(res.items, [], 'no items were ever seen under the expected key');
});

test('REGRESSION: the arrayKey is present but NOT an array -- also a shape anomaly, not treated as empty', async () => {
  const deps = makePagedDeps([{ ManualJournals: 'not-an-array' }]);
  const res = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', deps);
  assert.equal(res.truncated, true);
  assert.ok(res.shapeAnomaly);
  assert.match(res.shapeAnomaly!, /got string/, 'the caveat should name the actual (wrong) type it found');
});

test('fetchAllPaged: a shape anomaly on a LATER page still keeps the well-formed items already collected', async () => {
  const fullPage = { ManualJournals: Array.from({ length: 100 }, (_, i) => ({ ManualJournalID: `mj-${i}` })) };
  const deps = makePagedDeps([fullPage, { ManualJournals: null }]); // page 1 real+full, page 2 malformed
  const res = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', deps);
  assert.equal(res.items.length, 100, 'page 1\'s real items are kept even though page 2 was anomalous');
  assert.equal(res.truncated, true);
  assert.match(res.shapeAnomaly!, /page 2/);
});

test('fetchAllPaged: hitting the real page cap with well-formed data on every page sets truncated with NO shapeAnomaly', async () => {
  const fullPage = () => ({ ManualJournals: Array.from({ length: 100 }, (_, i) => ({ ManualJournalID: `mj-${i}` })) });
  const pages = Array.from({ length: MAX_PAGES_PER_ENDPOINT }, fullPage);
  const deps = makePagedDeps(pages);
  const res = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', deps);
  assert.equal(res.items.length, MAX_PAGES_PER_ENDPOINT * 100);
  assert.equal(res.truncated, true, 'a genuine page-cap hit is still reported as truncated');
  assert.equal(res.shapeAnomaly, undefined, 'a real page-cap hit is not a shape anomaly -- the caller keeps its own page-cap wording for this case');
});

test('assembleGl: a shape-anomaly caveat from fetchAllPaged surfaces verbatim in the result caveats (not the generic page-cap wording)', async () => {
  const state = liveTokenState();
  const tbByDate = new Map([['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])]]);
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.pathname === '/api.xro/2.0/Reports/TrialBalance') {
        const date = u.searchParams.get('date');
        const body = date ? tbByDate.get(date) : undefined;
        if (!body) throw new Error(`no TrialBalance stub for date=${date}`);
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (u.pathname === '/api.xro/2.0/ManualJournals') {
        // Malformed: the key is present but not an array -- the shape anomaly under test.
        return new Response(JSON.stringify({ ManualJournals: 'not-an-array' }), { status: 200 });
      }
      const arrayKeyByPath: Record<string, string> = {
        '/api.xro/2.0/Invoices': 'Invoices',
        '/api.xro/2.0/CreditNotes': 'CreditNotes',
        '/api.xro/2.0/BankTransactions': 'BankTransactions',
      };
      const key = arrayKeyByPath[u.pathname];
      if (!key) throw new Error(`unexpected fetch path ${u.pathname}`);
      return new Response(JSON.stringify({ [key]: [] }), { status: 200 });
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called -- the seeded token is already live'); }) as never,
    create: (async () => { throw new Error('create should never be called -- the seeded token is already live'); }) as never,
  };
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  assert.ok(
    result.caveats.some((c) => c.includes('/ManualJournals page 1') && c.includes('malformed')),
    'the precise shape-anomaly caveat must reach the caller, not a generic "hit the page cap" message that would misstate the cause',
  );
  assert.ok(
    !result.caveats.some((c) => c.includes('hit the 20-page cap')),
    'the generic page-cap wording must NOT also fire for a shape anomaly (that would misreport why the result is short)',
  );
});

/** A single account's row for one TrialBalance snapshot. debit/credit are THAT MONTH's period
 * movement (read directly, never diffed); ytdDebit/ytdCredit default to the SAME as debit/credit
 * (i.e. "this is the first month of the financial year", the simplest self-consistent case) unless
 * overridden -- tests that exercise the YTD self-check override them explicitly. */
function tbRow(id: string, name: string, debit: number, credit: number, ytdDebit = debit, ytdCredit = credit) {
  return row5(name, String(debit), String(credit), String(ytdDebit), String(ytdCredit), id);
}

/** A valid TrialBalance report body for the given account rows, or an INVALID (0-row) body when
 * `rows` is null -- simulates a parse failure / unrecognized response shape. */
function tbBody(rows: ReturnType<typeof tbRow>[] | null) {
  if (rows === null) return { Reports: [{}] }; // no Rows at all -> parses to 0 rows
  return { Reports: [{ Rows: [{ RowType: 'Section', Rows: rows }] }] };
}

/** `seed` optionally pre-fills what each list endpoint returns (e.g. { ManualJournals: [...] }) --
 * defaults to an empty array for every endpoint not explicitly seeded. Only TrialBalance dates
 * assembleGl actually requests (the months in [from, to], NOT the monthEndDates leading boundary --
 * assembleGl no longer fetches or diffs against that boundary) need a `tbByDate` entry. */
function makeGlDeps(tbByDate: Map<string, unknown>, seed: Record<string, unknown[]> = {}) {
  const state = liveTokenState();
  const whereByPath = new Map<string, string | null>();
  const deps = {
    fetchImpl: (async (url: string | URL) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.xero.com') throw new Error(`unexpected fetch host ${u.hostname}`);
      if (u.pathname === '/api.xro/2.0/Reports/TrialBalance') {
        const date = u.searchParams.get('date');
        const body = date ? tbByDate.get(date) : undefined;
        if (!body) throw new Error(`no TrialBalance stub for date=${date}`);
        return new Response(JSON.stringify(body), { status: 200 });
      }
      const arrayKeyByPath: Record<string, string> = {
        '/api.xro/2.0/ManualJournals': 'ManualJournals',
        '/api.xro/2.0/Invoices': 'Invoices',
        '/api.xro/2.0/CreditNotes': 'CreditNotes',
        '/api.xro/2.0/BankTransactions': 'BankTransactions',
      };
      const key = arrayKeyByPath[u.pathname];
      if (!key) throw new Error(`unexpected fetch path ${u.pathname}`);
      whereByPath.set(u.pathname, u.searchParams.get('where'));
      return new Response(JSON.stringify({ [key]: seed[key] ?? [] }), { status: 200 });
    }) as typeof fetch,
    read: (async () => ({ doc: state.doc, etag: state.etag })) as never,
    replace: (async () => { throw new Error('replace should never be called -- the seeded token is already live'); }) as never,
    create: (async () => { throw new Error('create should never be called -- the seeded token is already live'); }) as never,
  };
  return { deps, whereByPath };
}

test('assembleGl: happy path -- one month, TB movement read DIRECTLY (no diffing), no manual journals -- the full TB movement surfaces as an UNEXPLAINED variance', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])], // January's OWN period movement: 500 debit
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  assert.equal(result.months.length, 1);
  assert.equal(result.months[0].periodEnd, '2026-01-31');
  const [account] = result.months[0].accounts;
  assert.equal(account.tbMovement, 500);
  assert.equal(account.manualJournalNet, 0); // no ManualJournals stubbed -> net 0
  assert.equal(account.variance, 500); // unexplained by manual journals -- correctly nonzero here
  assert.ok(result.months[0].otherDocuments, 'each month carries its own otherDocuments');
});

// --- THE HEADLINE REGRESSION: the CFO's live acceptance-test finding, 2026-07-30 -----------------
// A prior version of this tool fetched TrialBalance at consecutive month-ends and DIFFED the period
// columns against each other, on the wrong assumption that they were a cumulative balance. Xero's
// period pair at a given `date` is ALREADY that month's movement -- diffing two already-period
// figures computes period(N) - period(N-1), which is exactly 0 - period(N-1) = -period(N-1) for an
// account with genuinely NO activity in month N. This is the regression proof that the tool no
// longer does that: an account with real November activity and ZERO December activity must report
// December's tbMovement as 0.00, never as -November's figure.

test('REGRESSION (CFO acceptance test, 2026-07-30): a month with NO real activity reports tbMovement 0, NOT the negated prior month figure', async () => {
  const tbByDate = new Map([
    ['2026-11-30', tbBody([tbRow('a1', 'Cash', 0, 12640455.18)])], // November: real activity, a big credit movement
    ['2026-12-31', tbBody([tbRow('a1', 'Cash', 0, 0, 0, 12640455.18)])], // December: NO period activity (debit/credit both 0); YTD carries forward
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-11-01', '2026-12-31', deps);
  assert.equal(result.months.length, 2);
  const nov = result.months.find((m) => m.periodEnd === '2026-11-30')!;
  const dec = result.months.find((m) => m.periodEnd === '2026-12-31')!;
  assert.equal(nov.accounts[0].tbMovement, -12640455.18, 'November\'s own movement is unaffected');
  assert.equal(dec.accounts[0].tbMovement, 0, 'December must read as 0 (its own period figure), never as the negated November figure (+12640455.18, the old bug\'s output)');
});

test('assembleGl: a POSTED manual journal that exactly explains the TB movement zeroes the variance', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])],
  ]);
  const { deps } = makeGlDeps(tbByDate, {
    ManualJournals: [{ Date: '2026-01-15', Status: 'POSTED', JournalLines: [{ AccountID: 'a1', LineAmount: 500 }] }],
  });
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  const [account] = result.months[0].accounts;
  assert.equal(account.tbMovement, 500);
  assert.equal(account.manualJournalNet, 500);
  assert.equal(account.variance, 0);
});

test('REGRESSION (Copilot, gl-assemble.ts): DRAFT and VOIDED manual journals are excluded from manualJournalNet -- only POSTED counts', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])],
  ]);
  const { deps } = makeGlDeps(tbByDate, {
    ManualJournals: [
      { Date: '2026-01-10', Status: 'DRAFT', JournalLines: [{ AccountID: 'a1', LineAmount: 9000 }] }, // never hit the TB
      { Date: '2026-01-12', Status: 'VOIDED', JournalLines: [{ AccountID: 'a1', LineAmount: -9000 }] }, // never hit the TB
      { Date: '2026-01-15', Status: 'POSTED', JournalLines: [{ AccountID: 'a1', LineAmount: 500 }] }, // the real, posted movement
    ],
  });
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  const [account] = result.months[0].accounts;
  assert.equal(account.manualJournalNet, 500, 'DRAFT/VOIDED journals must be excluded -- including them would wrongly disagree with the real TB');
  assert.equal(account.variance, 0);
});

test('REGRESSION (Copilot, gl-assemble.ts): a manual-journal-only account key (absent from TB movements) still surfaces in accounts, not silently dropped', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 0, 0)])], // a1 has NO movement this month
  ]);
  // A journal line references a DIFFERENT key ("code:999") never seen on the TB side at all --
  // simulating the documented name:/code: key-format mismatch fallback case.
  const { deps } = makeGlDeps(tbByDate, {
    ManualJournals: [{ Date: '2026-01-15', Status: 'POSTED', JournalLines: [{ AccountCode: '999', LineAmount: 250 }] }],
  });
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  const unmatched = result.months[0].accounts.find((a) => a.accountId === 'code:999');
  assert.ok(unmatched, 'the journal-only key must still appear in accounts, not be silently discarded');
  assert.equal(unmatched.tbMovement, 0, 'there was no TB movement recorded under this key');
  assert.equal(unmatched.manualJournalNet, 250);
  assert.equal(unmatched.variance, -250, 'the full unmatched journal amount surfaces as variance -- the visible "unmatched journal side" signal');
});

test('REGRESSION (Copilot, gl-assemble.ts): a month with an invalid (0-row) TrialBalance snapshot is OMITTED on its own -- it no longer takes a neighboring month down with it', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])], // valid
    ['2026-02-28', tbBody(null)], // invalid
    ['2026-03-31', tbBody([tbRow('a1', 'Cash', 300, 0)])], // valid
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-03-31', deps);
  assert.equal(result.months.length, 2, 'only February is omitted -- January and March each stand on their own snapshot now, unlike the old diff-based model');
  assert.ok(result.months.some((m) => m.periodEnd === '2026-01-31'));
  assert.ok(result.months.some((m) => m.periodEnd === '2026-03-31'));
  assert.ok(result.caveats.some((c) => c.includes('2026-02-28') && c.includes('OMITTED')), 'a caveat must explain the omission');
});

test('assembleGl: an unresolvable TrialBalance row surfaces as a loud caveat, not a silent gap', async () => {
  const unresolvableRow = { RowType: 'Row', Cells: [{ Value: '' }, { Value: '7365719.00' }, { Value: '0.00' }] };
  const tbByDate = new Map([
    ['2026-01-31', { Reports: [{ Rows: [{ RowType: 'Section', Rows: [tbRow('a1', 'Cash', 500, 0), unresolvableRow] }] }] }],
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  assert.equal(result.months[0].accounts.length, 1, 'the resolvable account still comes through');
  assert.ok(result.caveats.some((c) => c.includes('2026-01-31') && c.includes('no resolvable account')), 'the unresolved row must be a named caveat');
});

test('REGRESSION (Copilot, gl-assemble.ts): a partial-month request still queries ManualJournals/Invoices/CreditNotes/BankTransactions over the WIDENED whole-month bounds, not the raw from/to', async () => {
  const tbByDate = new Map([
    ['2026-03-31', tbBody([tbRow('a1', 'Cash', 500, 0)])],
  ]);
  const { deps, whereByPath } = makeGlDeps(tbByDate);
  // A partial-month request: March 5 - March 20, well short of the full month.
  await assembleGl('otchealth', '2026-03-05', '2026-03-20', deps);
  const mjWhere = whereByPath.get('/api.xro/2.0/ManualJournals')!;
  // Must reflect the WIDENED month (March 1 - March 31), never the raw partial request.
  assert.match(mjWhere, /DateTime\(2026,3,1\)/, 'the effective from must be widened to the 1st of the month, not the 5th');
  assert.match(mjWhere, /DateTime\(2026,3,31\)/, 'the effective to must be widened to month-end, not the 20th');
  assert.match(mjWhere, /Status=="POSTED"/, 'ManualJournals must also be server-side filtered to POSTED only');
  // ManualJournals carries the SAME widened date bounds as the other three, PLUS its own
  // Status=="POSTED" suffix -- so it is a strict prefix match, not exact equality.
  const dateOnlyBounds = mjWhere.replace(' && Status=="POSTED"', '');
  for (const path of ['/api.xro/2.0/Invoices', '/api.xro/2.0/CreditNotes', '/api.xro/2.0/BankTransactions']) {
    assert.equal(whereByPath.get(path), dateOnlyBounds, `${path} must use the SAME widened date bounds as ManualJournals`);
  }
});

// -- YTD-vs-period self-check (the CFO's requested "cheap and worth it" cross-check) --------------

test('self-check: a consistent YTD/period relationship across two months produces NO mismatch caveat', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0, 500, 0)])], // Jan: period 500, YTD 500 (first month of FY)
    ['2026-02-28', tbBody([tbRow('a1', 'Cash', 300, 0, 800, 0)])], // Feb: period 300, YTD 800 = 500 + 300 (consistent)
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-02-28', deps);
  assert.ok(!result.caveats.some((c) => c.includes('disagrees with YTD')), 'no self-check caveat when the numbers are internally consistent');
});

test('self-check: an inconsistent YTD/period relationship across two months IS flagged as a caveat', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0, 500, 0)])], // Jan: period 500, YTD 500
    ['2026-02-28', tbBody([tbRow('a1', 'Cash', 300, 0, 999, 0)])], // Feb: period 300, but YTD 999 != 500+300=800 -- inconsistent
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-02-28', deps);
  assert.ok(result.caveats.some((c) => c.includes('2026-02-28') && c.includes('disagrees with YTD')), 'a real YTD/period disagreement must be surfaced as a caveat');
});

test('self-check: does not run on the FIRST requested month (no prior month\'s YTD to compare against)', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0, 999999, 0)])], // a YTD figure that would "mismatch" against nothing
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  assert.ok(!result.caveats.some((c) => c.includes('disagrees with YTD')), 'the first requested month has no prior-month YTD to check against, so it must not fire');
});

test('REGRESSION (Copilot, gl-assemble.ts): the self-check does NOT fabricate a mismatch caveat for every account when the PRIOR month\'s own TrialBalance snapshot was invalid (0 rows)', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])], // valid
    ['2026-02-28', tbBody(null)], // invalid -- 0 rows, becomes the PRIOR snapshot for March
    // March's own YTD (1400) deliberately does NOT equal its period movement (300) minus a
    // fabricated prior-YTD-of-0 -- the old code's empty-prior-map fallback (`?? 0`) would compute
    // expectedPeriod = 1400 - 0 = 1400 vs actualPeriod = 300 and wrongly flag a mismatch here.
    ['2026-03-31', tbBody([tbRow('a1', 'Cash', 300, 0, 1400, 0)])], // valid
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-03-31', deps);
  assert.equal(result.months.length, 2, 'January and March, February omitted');
  assert.ok(
    !result.caveats.some((c) => c.includes('2026-03-31') && c.includes('disagrees with YTD')),
    'March must NOT get a fabricated self-check caveat just because February (its immediate predecessor) was an invalid snapshot',
  );
});

test('assembleGl: periodStart is the first day of ITS OWN month for every entry, not the previous entry\'s periodEnd (no overlapping boundary)', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])],
    ['2026-02-28', tbBody([tbRow('a1', 'Cash', 300, 0)])],
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-02-28', deps);
  const jan = result.months.find((m) => m.periodEnd === '2026-01-31')!;
  const feb = result.months.find((m) => m.periodEnd === '2026-02-28')!;
  assert.equal(jan.periodStart, '2026-01-01');
  assert.equal(feb.periodStart, '2026-02-01', 'must be the first day of February, NOT January\'s periodEnd (2026-01-31), which would overlap with January\'s own reported range');
});

// ============================================================================================
// FND-20260829-e454: wall-clock budget + continuation.
//
// xeroGet's own mandatory ~1.1s per-call rate spacing (client.ts, MIN_SPACING_MS) is REAL and
// applies regardless of the FAKE `now`/`budgetMs` these tests inject -- the injected clock governs
// only assembleGl's OWN budget decision (how many months/pages to attempt), not xeroGet's real
// inter-call delay. So these tests still take a little real wall-clock time (consistent with this
// file's other assembleGl tests above), just never anywhere near the real production budget.
// ============================================================================================

test('resolveGlAssembleBudgetMs: unset/garbage/non-positive -> the default; a valid value honored up to a hard ceiling that a misconfiguration can never exceed', () => {
  const DEFAULT_MS = resolveGlAssembleBudgetMs(undefined);
  assert.equal(resolveGlAssembleBudgetMs('not a number'), DEFAULT_MS);
  assert.equal(resolveGlAssembleBudgetMs('0'), DEFAULT_MS);
  assert.equal(resolveGlAssembleBudgetMs('-500'), DEFAULT_MS);
  assert.equal(resolveGlAssembleBudgetMs('10000'), 10_000);
  assert.ok(resolveGlAssembleBudgetMs('999999') < 45_000, 'a misconfigured huge override can never approach a 45-second-class MCP client timeout');
});

test('fetchAllPaged BUDGET: an already-exhausted shared budget stops BEFORE the first page fetch, marking truncated with a distinguishing (not page-cap) message', async () => {
  const deps = makePagedDeps([{ ManualJournals: [{ ManualJournalID: 'should-never-be-fetched' }] }]);
  const res = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', deps, { deadline: 0, now: () => 1 });
  assert.deepEqual(res.items, [], 'the page was never fetched at all');
  assert.equal(res.truncated, true);
  assert.match(res.shapeAnomaly!, /bounded wall-clock budget exhausted/);
  assert.doesNotMatch(res.shapeAnomaly!, /hit the.*page cap/i, 'must not be confused with an actual page-cap hit (the caller\'s own generic page-cap wording)');
});

test('fetchAllPaged BUDGET: an unexhausted (or omitted) budget behaves exactly as before -- no behavior change for every existing direct caller/test above', async () => {
  const fullPage = { ManualJournals: [{ ManualJournalID: 'mj-1' }] };
  const depsA = makePagedDeps([fullPage]);
  const withoutBudget = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', depsA);
  const depsB = makePagedDeps([fullPage]);
  const withGenerousBudget = await fetchAllPaged('otchealth', '/ManualJournals', 'ManualJournals', 'where', depsB, { deadline: Infinity, now: Date.now });
  assert.deepEqual(withoutBudget, withGenerousBudget);
  assert.equal(withoutBudget.truncated, false);
});

test('assembleGl BUDGET: the TrialBalance loop stops early when the budget runs out mid-range -- already-completed months are kept, the document window narrows to just them, and the result is honestly partial with a continuation naming the exact remainder', async () => {
  const tbByDate = new Map([
    ['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])],
    ['2026-02-28', tbBody([tbRow('a1', 'Cash', 300, 0)])], // must NEVER be fetched -- budget exhausted before this date
    ['2026-03-31', tbBody([tbRow('a1', 'Cash', 100, 0)])], // must NEVER be fetched either
  ]);
  // A fake clock the January TrialBalance fetch itself advances -- tied to the ACTUAL network call
  // that would realistically consume time in production, rather than a fragile call-count guess
  // about how many times assembleGl happens to invoke now() before/around the loop.
  let clock = 0;
  const now = () => clock;
  const { deps, whereByPath } = makeGlDeps(tbByDate);
  const realFetchImpl = deps.fetchImpl;
  deps.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const res = await realFetchImpl(url, init);
    if (new URL(String(url)).searchParams.get('date') === '2026-01-31') clock += 999_999;
    return res;
  }) as typeof fetch;
  const result = await assembleGl('otchealth', '2026-01-01', '2026-03-31', deps, { now, budgetMs: 1_000 });

  assert.equal(result.months.length, 1, 'only January was processed');
  assert.equal(result.months[0]!.periodEnd, '2026-01-31');
  assert.equal(result.partial, true);
  assert.ok(result.continuation);
  assert.equal(result.continuation!.from, firstDayOfMonth('2026-02-28'), 'the continuation resumes at February, the first UNPROCESSED month');
  assert.equal(result.continuation!.to, '2026-03-31', 'the original `to` is preserved verbatim');
  assert.ok(result.caveats.some((c) => c.includes('assembling 1/3 requested month(s)')));
  // The SAME shared deadline that stopped the TrialBalance loop also gates the four document
  // fetches that would otherwise follow (they share one `budget`, not independent allowances) --
  // so no ManualJournals/Invoices/CreditNotes/BankTransactions request happens at all once the
  // budget is already gone, rather than wastefully fetching documents for a range whose months
  // this call cannot even report on.
  assert.equal(whereByPath.size, 0, 'no document endpoint should be reached once the shared budget is already exhausted');
});

test('assembleGl BUDGET: when the budget is already gone before even the FIRST month, nothing is fetched beyond that one call -- an honest immediate partial with continuation = the exact original request (safe to just retry)', async () => {
  const tbByDate = new Map([['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])]]); // must never be fetched
  const { deps } = makeGlDeps(tbByDate);
  let calls = 0;
  const now = () => (calls++ === 0 ? 0 : 999_999); // over budget from the very first per-date check
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps, { now, budgetMs: 1_000 });
  assert.deepEqual(result.months, []);
  assert.equal(result.partial, true);
  assert.deepEqual(result.continuation, { from: '2026-01-01', to: '2026-01-31' }, 'nothing was assembled -- resuming means simply retrying the same request');
  assert.ok(result.caveats.some((c) => c.includes('exhausted before even the first requested month')));
});

test('assembleGl BUDGET: a normal, budget-respecting call carries neither partial nor continuation (lock: the fix is purely additive)', async () => {
  const tbByDate = new Map([['2026-01-31', tbBody([tbRow('a1', 'Cash', 500, 0)])]]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps, { budgetMs: 60_000 });
  assert.equal(result.months.length, 1);
  assert.equal('partial' in result, false);
  assert.equal('continuation' in result, false);
});
