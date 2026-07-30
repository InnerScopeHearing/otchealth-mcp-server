import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthEndIso,
  monthEndDates,
  parseTrialBalanceRows,
  diffTrialBalances,
  sumManualJournalsByAccount,
  sumLineItemsByAccount,
} from './gl-assemble.js';

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
