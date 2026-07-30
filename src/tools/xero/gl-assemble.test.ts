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
  diffTrialBalances,
  sumManualJournalsByAccount,
  sumLineItemsByAccount,
  assembleGl,
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

test('monthEndDates: one calendar month returns [baseline, monthEnd] — 2 entries', () => {
  const dates = monthEndDates('2026-03-05', '2026-03-20');
  assert.deepEqual(dates, ['2026-02-28', '2026-03-31']);
});

test('monthEndDates: a full year returns baseline + 12 month-ends = 13 entries, in order', () => {
  const dates = monthEndDates('2026-01-01', '2026-12-31');
  assert.equal(dates.length, 13);
  assert.equal(dates[0], '2025-12-31'); // baseline: the month BEFORE January
  assert.equal(dates[1], '2026-01-31');
  assert.equal(dates[12], '2026-12-31');
});

test('monthEndDates: baseline correctly rolls back across a year boundary (January -> prior December)', () => {
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

test('parseTrialBalanceRows: flattens a Section > Row structure, keeping account id + debit/credit', () => {
  const body = tbReportBody([
    { RowType: 'Header', Cells: [{ Value: 'Account' }, { Value: 'Debit' }, { Value: 'Credit' }] },
    {
      RowType: 'Section',
      Title: 'Revenue',
      Rows: [
        {
          RowType: 'Row',
          Cells: [
            { Value: 'Sales', Attributes: [{ Id: 'account', Value: 'acc-guid-1' }] },
            { Value: '0.00' },
            { Value: '1234.56' },
          ],
        },
      ],
    },
    {
      RowType: 'Section',
      Title: 'Bank',
      Rows: [
        {
          RowType: 'Row',
          Cells: [
            { Value: 'Business Checking', Attributes: [{ Id: 'account', Value: 'acc-guid-2' }] },
            { Value: '5000.00' },
            { Value: '0.00' },
          ],
        },
        { RowType: 'SummaryRow', Cells: [{ Value: 'Total Bank' }, { Value: '5000.00' }, { Value: '0.00' }] },
      ],
    },
  ]);
  const rows = parseTrialBalanceRows(body);
  assert.equal(rows.length, 2); // the SummaryRow is skipped
  assert.deepEqual(rows[0], { accountId: 'acc-guid-1', name: 'Sales', debit: 0, credit: 1234.56 });
  assert.deepEqual(rows[1], { accountId: 'acc-guid-2', name: 'Business Checking', debit: 5000, credit: 0 });
});

test('parseTrialBalanceRows: falls back to a name-derived key when no "account" attribute is present', () => {
  const body = tbReportBody([
    { RowType: 'Section', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Mystery Account' }, { Value: '10.00' }, { Value: '0.00' }] }] },
  ]);
  const rows = parseTrialBalanceRows(body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, 'name:Mystery Account');
});

test('parseTrialBalanceRows: an empty/unrecognized shape returns [] rather than throwing', () => {
  assert.deepEqual(parseTrialBalanceRows(null), []);
  assert.deepEqual(parseTrialBalanceRows({}), []);
  assert.deepEqual(parseTrialBalanceRows({ Reports: [] }), []);
  assert.deepEqual(parseTrialBalanceRows({ Reports: [{}] }), []);
});

// -------------------------------------------------------------------------------------------
// diffTrialBalances
// -------------------------------------------------------------------------------------------

test('diffTrialBalances: net movement = (curr debit-credit) - (prev debit-credit)', () => {
  const prev = [{ accountId: 'a1', name: 'Cash', debit: 1000, credit: 0 }];
  const curr = [{ accountId: 'a1', name: 'Cash', debit: 1500, credit: 0 }];
  const [m] = diffTrialBalances(prev, curr);
  assert.equal(m.tbMovement, 500);
});

test('diffTrialBalances: an account that only exists in the CURRENT snapshot (newly opened) treats prior as 0', () => {
  const prev: ReturnType<typeof parseTrialBalanceRows> = [];
  const curr = [{ accountId: 'a2', name: 'New Account', debit: 0, credit: 250 }];
  const [m] = diffTrialBalances(prev, curr);
  assert.equal(m.accountId, 'a2');
  assert.equal(m.tbMovement, -250);
});

test('diffTrialBalances: an account that only existed in the PRIOR snapshot (zeroed out / closed) treats current as 0', () => {
  const prev = [{ accountId: 'a3', name: 'Closed Account', debit: 100, credit: 0 }];
  const curr: ReturnType<typeof parseTrialBalanceRows> = [];
  const [m] = diffTrialBalances(prev, curr);
  assert.equal(m.tbMovement, -100);
});

test('diffTrialBalances: no movement across two identical snapshots nets to exactly 0', () => {
  const snap = [{ accountId: 'a1', name: 'Cash', debit: 1000, credit: 0 }];
  const [m] = diffTrialBalances(snap, snap);
  assert.equal(m.tbMovement, 0);
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
// assembleGl — orchestrator integration tests (Copilot review, 2026-07-30). These are the
// regression proofs for the two most severe findings on this tool: a fabricated-movement bug
// (diffing a real TB snapshot against a failed-to-parse one) and a date-range mismatch (TB
// snapshots widened to whole months while the document fetches stayed on the caller's raw,
// possibly-partial-month from/to). Deps-injected: no real Cosmos or Xero.
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

function tbRow(id, name, debit, credit) {
  return { RowType: 'Row', Cells: [{ Value: name, Attributes: [{ Id: 'account', Value: id }] }, { Value: String(debit) }, { Value: String(credit) }] };
}

/** A valid TrialBalance report body for the given account rows, or an INVALID (0-row) body when
 * `rows` is null -- simulates a parse failure / unrecognized response shape. */
function tbBody(rows) {
  if (rows === null) return { Reports: [{}] }; // no Rows at all -> parses to 0 rows
  return { Reports: [{ Rows: [{ RowType: 'Section', Rows: rows.map((r) => tbRow(r.id, r.name, r.debit, r.credit)) }] }] };
}

/** Builds a deps object: `read` returns an already-live token (so getOrgAccess never needs to
 * refresh or hit identity.xero.com/connections), `replace`/`create` throw if called (proving the
 * seeded live token was used directly), and `fetchImpl` routes purely on api.xero.com PATHNAME:
 * TrialBalance reads are answered per-date from `tbByDate` (keyed by the `date` query param);
 * every other list endpoint is captured into `whereByPath` (keyed by pathname) and answered with
 * an empty collection, since these tests are about the TB-diff/date-alignment logic, not the
 * document content itself. */
function makeGlDeps(tbByDate) {
  const state = liveTokenState();
  const whereByPath = new Map();
  const deps = {
    fetchImpl: (async (url) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.xero.com') throw new Error(`unexpected fetch host ${u.hostname}`);
      if (u.pathname === '/api.xro/2.0/Reports/TrialBalance') {
        const date = u.searchParams.get('date');
        const body = tbByDate.get(date);
        if (!body) throw new Error(`no TrialBalance stub for date=${date}`);
        return new Response(JSON.stringify(body), { status: 200 });
      }
      const arrayKeyByPath = {
        '/api.xro/2.0/ManualJournals': 'ManualJournals',
        '/api.xro/2.0/Invoices': 'Invoices',
        '/api.xro/2.0/CreditNotes': 'CreditNotes',
        '/api.xro/2.0/BankTransactions': 'BankTransactions',
      };
      const key = arrayKeyByPath[u.pathname];
      if (!key) throw new Error(`unexpected fetch path ${u.pathname}`);
      whereByPath.set(u.pathname, u.searchParams.get('where'));
      return new Response(JSON.stringify({ [key]: [] }), { status: 200 });
    }),
    read: (async () => ({ doc: state.doc, etag: state.etag })),
    replace: (async () => { throw new Error('replace should never be called -- the seeded token is already live'); }),
    create: (async () => { throw new Error('create should never be called -- the seeded token is already live'); }),
  };
  return { deps, whereByPath };
}

test('assembleGl: happy path -- one full month, real snapshots, ManualJournals fully explains the movement (variance 0)', async () => {
  const tbByDate = new Map([
    ['2025-12-31', tbBody([{ id: 'a1', name: 'Cash', debit: 1000, credit: 0 }])],
    ['2026-01-31', tbBody([{ id: 'a1', name: 'Cash', debit: 1500, credit: 0 }])],
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-01-31', deps);
  assert.equal(result.months.length, 1);
  assert.equal(result.months[0].periodStart, '2025-12-31');
  assert.equal(result.months[0].periodEnd, '2026-01-31');
  const [account] = result.months[0].accounts;
  assert.equal(account.tbMovement, 500);
  assert.equal(account.manualJournalNet, 0); // no ManualJournals stubbed -> net 0
  assert.equal(account.variance, 500); // unexplained by manual journals -- correctly nonzero here
  assert.ok(result.months[0].otherDocuments, 'each month carries its own otherDocuments');
});

test('REGRESSION (Copilot, gl-assemble.ts:350): a month touching an invalid (0-row) TrialBalance snapshot is OMITTED, never diffed into a fabricated movement', async () => {
  // Dec (real, 1000) -> Jan (INVALID, parse failure) -> Feb (real, 1000 again). If the bug were
  // present, Dec->Jan would show a fabricated -1000 movement and Jan->Feb a fabricated +1000
  // reinstatement. Neither period should appear in `months` at all.
  const tbByDate = new Map([
    ['2025-12-31', tbBody([{ id: 'a1', name: 'Cash', debit: 1000, credit: 0 }])],
    ['2026-01-31', tbBody(null)], // invalid
    ['2026-02-28', tbBody([{ id: 'a1', name: 'Cash', debit: 1000, credit: 0 }])],
  ]);
  const { deps } = makeGlDeps(tbByDate);
  const result = await assembleGl('otchealth', '2026-01-01', '2026-02-28', deps);
  assert.equal(result.months.length, 0, 'both periods touch the invalid January snapshot and must be omitted, not fabricated');
  assert.ok(result.caveats.some((c) => c.includes('2026-01-31') && c.includes('OMITTED')), 'a caveat must explain the omission');
});

test('REGRESSION (Copilot, gl-assemble.ts:354): a partial-month request still queries ManualJournals/Invoices/CreditNotes/BankTransactions over the WIDENED whole-month bounds, not the raw from/to', async () => {
  const tbByDate = new Map([
    ['2026-02-28', tbBody([{ id: 'a1', name: 'Cash', debit: 1000, credit: 0 }])],
    ['2026-03-31', tbBody([{ id: 'a1', name: 'Cash', debit: 1500, credit: 0 }])],
  ]);
  const { deps, whereByPath } = makeGlDeps(tbByDate);
  // A partial-month request: March 5 - March 20, well short of the full month.
  await assembleGl('otchealth', '2026-03-05', '2026-03-20', deps);
  const mjWhere = whereByPath.get('/api.xro/2.0/ManualJournals');
  // Must reflect the WIDENED month (March 1 - March 31), never the raw partial request.
  assert.match(mjWhere, /DateTime\(2026,3,1\)/, 'the effective from must be widened to the 1st of the month, not the 5th');
  assert.match(mjWhere, /DateTime\(2026,3,31\)/, 'the effective to must be widened to month-end, not the 20th');
  for (const path of ['/api.xro/2.0/Invoices', '/api.xro/2.0/CreditNotes', '/api.xro/2.0/BankTransactions']) {
    assert.equal(whereByPath.get(path), mjWhere, `${path} must use the SAME widened bounds as ManualJournals`);
  }
});
