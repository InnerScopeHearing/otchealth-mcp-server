import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for xero_aggregate's PURE reducer (issue #291b). No network, no Cosmos, no clock:
 * every arithmetic claim this tool makes is exercised directly against fixtures, mirroring
 * gl-assemble.test.ts's split. The whole point of this tool is that a count/sum is computed once,
 * server-side, instead of by a model paging JIT chunks — so the arithmetic has to be pinned here,
 * not merely observed working against live data one afternoon.
 */
const {
  reduceAggregate,
  parseXeroDate,
  buildAggregateWhere,
  groupKeyString,
  needsLineExplosion,
  round2,
  MISSING_KEY,
} = await import('./aggregate.js');

type Group = { key: Record<string, string>; count: number; sums: Record<string, number> };

function find(groups: Group[], key: Record<string, string>): Group {
  const want = groupKeyString(key);
  const hit = groups.find((g) => groupKeyString(g.key) === want);
  assert.ok(hit, `expected a group for ${want}; got ${groups.map((g) => groupKeyString(g.key)).join(' / ')}`);
  return hit;
}

// -------------------------------------------------------------------------------------------
// Date parsing — Xero's two real wire forms
// -------------------------------------------------------------------------------------------

test('parseXeroDate: the .NET /Date(ms+offset)/ form parses to the right UTC instant', () => {
  const d = parseXeroDate('/Date(1620000000000+0000)/');
  assert.ok(d);
  assert.equal(d.toISOString(), '2021-05-03T00:00:00.000Z');
  assert.equal(d.getUTCFullYear(), 2021);
  assert.equal(d.getUTCMonth() + 1, 5);
});

test('parseXeroDate: ISO forms parse, and anything unparseable returns null (never a NaN Date)', () => {
  assert.equal(parseXeroDate('2022-01-31T00:00:00')?.getUTCFullYear(), 2022);
  assert.equal(parseXeroDate('2023-07-04')?.getUTCFullYear(), 2023);
  assert.equal(parseXeroDate('not-a-date'), null);
  assert.equal(parseXeroDate(''), null);
  assert.equal(parseXeroDate(undefined), null);
  assert.equal(parseXeroDate(12345), null, 'a non-string must not be coerced into a date');
});

// -------------------------------------------------------------------------------------------
// Invoices grouped by Type + Status, summing Total and AmountDue
// -------------------------------------------------------------------------------------------

function invoice(type: string, status: string, total: number, amountDue: number, date = '/Date(1620000000000+0000)/') {
  return { Type: type, Status: status, Total: total, AmountDue: amountDue, Date: date };
}

test('reduceAggregate: Invoices grouped by Type+Status sum Total and AmountDue per bucket', () => {
  const records = [
    invoice('ACCPAY', 'AUTHORISED', 100.5, 100.5),
    invoice('ACCPAY', 'AUTHORISED', 200.25, 0),
    invoice('ACCPAY', 'PAID', 50, 0),
    invoice('ACCREC', 'AUTHORISED', 1000, 250.1),
  ];
  const out = reduceAggregate(records, {
    resource: 'Invoices',
    group_by: ['Type', 'Status'],
    metrics: ['Total', 'AmountDue'],
  });

  assert.equal(out.itemCount, 4);
  assert.equal(out.groups.length, 3);

  const accpayAuth = find(out.groups as Group[], { Type: 'ACCPAY', Status: 'AUTHORISED' });
  assert.equal(accpayAuth.count, 2);
  assert.equal(accpayAuth.sums.Total, 300.75);
  assert.equal(accpayAuth.sums.AmountDue, 100.5);

  const accpayPaid = find(out.groups as Group[], { Type: 'ACCPAY', Status: 'PAID' });
  assert.equal(accpayPaid.count, 1);
  assert.equal(accpayPaid.sums.Total, 50);

  const accrec = find(out.groups as Group[], { Type: 'ACCREC', Status: 'AUTHORISED' });
  assert.equal(accrec.sums.AmountDue, 250.1);

  assert.ok(
    out.caveats.some((c) => /CURRENT-STATE, not as-at/.test(c)),
    'summing AmountDue must always carry the current-state caveat — the figure is not an as-at balance',
  );
});

test('reduceAggregate: sums are rounded to 2dp, so float drift never leaks into a financial figure', () => {
  const records = [invoice('ACCPAY', 'AUTHORISED', 0.1, 0), invoice('ACCPAY', 'AUTHORISED', 0.2, 0)];
  const out = reduceAggregate(records, { resource: 'Invoices', group_by: ['Type'], metrics: ['Total'] });
  assert.equal(find(out.groups as Group[], { Type: 'ACCPAY' }).sums.Total, 0.3);
  assert.equal(round2(0.1 + 0.2), 0.3);
});

test('reduceAggregate: an empty group_by yields exactly ONE whole-population group', () => {
  const out = reduceAggregate([invoice('ACCPAY', 'AUTHORISED', 10, 10), invoice('ACCREC', 'PAID', 5, 0)], {
    resource: 'Invoices',
    group_by: [],
    metrics: ['Total'],
  });
  assert.equal(out.groups.length, 1);
  assert.deepEqual(out.groups[0]?.key, {});
  assert.equal(out.groups[0]?.count, 2);
  assert.equal(out.groups[0]?.sums.Total, 15);
});

test('reduceAggregate: a missing grouped field becomes the explicit MISSING_KEY placeholder, never an empty string', () => {
  const out = reduceAggregate([{ Total: 5 }], { resource: 'Invoices', group_by: ['Status'], metrics: ['Total'] });
  assert.equal(out.groups[0]?.key.Status, MISSING_KEY);
});

// -------------------------------------------------------------------------------------------
// Payments grouped by Year — counts (the CFO's 2021/2022/2023 census shape)
// -------------------------------------------------------------------------------------------

test('reduceAggregate: Payments grouped by Year give per-year counts and summed Amount', () => {
  const payments = [
    { Status: 'AUTHORISED', Amount: 10, Date: '/Date(1609459200000+0000)/' }, // 2021-01-01
    { Status: 'AUTHORISED', Amount: 20, Date: '/Date(1620000000000+0000)/' }, // 2021-05-03
    { Status: 'AUTHORISED', Amount: 30, Date: '/Date(1641000000000+0000)/' }, // 2022-01-01
    { Status: 'AUTHORISED', Amount: 40, Date: '2023-07-04' },
    { Status: 'AUTHORISED', Amount: 50, Date: '2023-12-31' },
  ];
  const out = reduceAggregate(payments, { resource: 'Payments', group_by: ['Year'], metrics: ['Amount'] });

  assert.equal(out.itemCount, 5);
  assert.equal(find(out.groups as Group[], { Year: '2021' }).count, 2);
  assert.equal(find(out.groups as Group[], { Year: '2022' }).count, 1);
  assert.equal(find(out.groups as Group[], { Year: '2023' }).count, 2);
  assert.equal(find(out.groups as Group[], { Year: '2023' }).sums.Amount, 90);
});

test('reduceAggregate: Month grouping is zero-padded YYYY-MM so buckets sort lexicographically', () => {
  const out = reduceAggregate(
    [
      { Amount: 1, Date: '2022-09-01' },
      { Amount: 2, Date: '2022-10-01' },
    ],
    { resource: 'Payments', group_by: ['Month'], metrics: ['Amount'] },
  );
  assert.deepEqual(
    out.groups.map((g) => g.key.Month),
    ['2022-09', '2022-10'],
  );
});

test('reduceAggregate: fromDate/toDate filter client-side, and an unparseable date is KEPT plus caveated', () => {
  const records = [
    { Amount: 1, Date: '2021-06-01' },
    { Amount: 2, Date: '2022-06-01' },
    { Amount: 4, Date: 'not-a-date' },
  ];
  const out = reduceAggregate(records, {
    resource: 'Payments',
    group_by: [],
    metrics: ['Amount'],
    fromDate: '2022-01-01',
    toDate: '2022-12-31',
  });
  assert.equal(out.itemCount, 2, 'the 2021 record is filtered out; the unparseable-date record is kept');
  assert.equal(out.groups[0]?.sums.Amount, 6);
  assert.ok(out.caveats.some((c) => /unparseable Date/.test(c)));
});

// -------------------------------------------------------------------------------------------
// ManualJournals exploded by AccountCode
// -------------------------------------------------------------------------------------------

test('reduceAggregate: ManualJournals explode by AccountCode — each JournalLine lands in its own bucket', () => {
  const journals = [
    {
      Status: 'POSTED',
      Date: '2022-01-31',
      Total: 1500.5,
      JournalLines: [
        { AccountCode: '1251', LineAmount: 1500.5 },
        { AccountCode: '2000', LineAmount: -1500.5 },
      ],
    },
    {
      Status: 'POSTED',
      Date: '2022-02-28',
      Total: 100,
      JournalLines: [
        { AccountCode: '1251', LineAmount: 100 },
        { AccountCode: '1251', LineAmount: 25 },
      ],
    },
  ];
  const out = reduceAggregate(journals, {
    resource: 'ManualJournals',
    group_by: ['AccountCode'],
    metrics: ['LineAmount'],
  });

  assert.equal(out.itemCount, 2, 'itemCount stays a RECORD count even when lines are exploded');
  const a1251 = find(out.groups as Group[], { AccountCode: '1251' });
  assert.equal(a1251.count, 3, 'count is a LINE count in exploded mode');
  assert.equal(a1251.sums.LineAmount, 1625.5);
  const a2000 = find(out.groups as Group[], { AccountCode: '2000' });
  assert.equal(a2000.sums.LineAmount, -1500.5);
  assert.ok(out.caveats.some((c) => /Line-exploded/.test(c)));
});

test('reduceAggregate: in exploded mode a RECORD-level metric is added once per (group, record), not once per line', () => {
  const journals = [
    {
      Total: 900,
      Date: '2022-01-31',
      JournalLines: [
        { AccountCode: '1251', LineAmount: 300 },
        { AccountCode: '1251', LineAmount: 300 },
        { AccountCode: '1251', LineAmount: 300 },
      ],
    },
  ];
  const out = reduceAggregate(journals, {
    resource: 'ManualJournals',
    group_by: ['AccountCode'],
    metrics: ['LineAmount', 'Total'],
  });
  const g = find(out.groups as Group[], { AccountCode: '1251' });
  assert.equal(g.count, 3);
  assert.equal(g.sums.LineAmount, 900);
  assert.equal(g.sums.Total, 900, 'a 3-line journal must contribute its Total ONCE, not 3x (2700 would be the bug)');
});

test('reduceAggregate: a line with only an AccountID buckets under id:<guid> rather than collapsing into (none)', () => {
  const out = reduceAggregate(
    [{ Total: 5, Date: '2022-01-31', JournalLines: [{ AccountID: 'guid-1', LineAmount: 5 }] }],
    { resource: 'ManualJournals', group_by: ['AccountCode'], metrics: ['LineAmount'] },
  );
  assert.equal(out.groups[0]?.key.AccountCode, 'id:guid-1');
});

test('reduceAggregate: an exploded record with NO lines is still counted, bucketed under the missing-account key', () => {
  const out = reduceAggregate([{ Total: 42, Date: '2022-01-31' }], {
    resource: 'ManualJournals',
    group_by: ['AccountCode'],
    metrics: ['Total'],
  });
  assert.equal(out.itemCount, 1, 'a line-less record must never vanish from the population');
  assert.equal(out.groups[0]?.key.AccountCode, MISSING_KEY);
  assert.equal(out.groups[0]?.sums.Total, 42);
  assert.ok(out.caveats.some((c) => /no line array/.test(c)));
});

test('reduceAggregate: Invoices explode via LineItems (not JournalLines) when grouped by AccountCode', () => {
  const out = reduceAggregate(
    [
      {
        Type: 'ACCREC',
        Date: '2022-03-01',
        Total: 300,
        LineItems: [
          { AccountCode: '200', LineAmount: 200 },
          { AccountCode: '260', LineAmount: 100 },
        ],
      },
    ],
    { resource: 'Invoices', group_by: ['AccountCode'], metrics: ['LineAmount'] },
  );
  assert.equal(find(out.groups as Group[], { AccountCode: '200' }).sums.LineAmount, 200);
  assert.equal(find(out.groups as Group[], { AccountCode: '260' }).sums.LineAmount, 100);
});

test('needsLineExplosion: true for an AccountCode grouping OR a LineAmount metric, false otherwise', () => {
  assert.equal(needsLineExplosion(['AccountCode'], ['Total']), true);
  assert.equal(needsLineExplosion(['Status'], ['LineAmount']), true);
  assert.equal(needsLineExplosion(['Status', 'Year'], ['Total', 'AmountDue']), false);
});

// -------------------------------------------------------------------------------------------
// where construction — the deleted/voided default that every other xero_* tool only warns about
// -------------------------------------------------------------------------------------------

test('buildAggregateWhere: include_deleted:false prepends the AUTHORISED guard, joined with AND', () => {
  assert.equal(buildAggregateWhere(undefined, false), 'Status=="AUTHORISED"');
  assert.equal(buildAggregateWhere('RemainingCredit>0', false), 'Status=="AUTHORISED" AND RemainingCredit>0');
});

test('buildAggregateWhere: a caller who names Status themselves is never second-guessed', () => {
  assert.equal(buildAggregateWhere('Status=="VOIDED"', false), 'Status=="VOIDED"');
});

test('buildAggregateWhere: include_deleted:true sends the caller filter verbatim (or nothing at all)', () => {
  assert.equal(buildAggregateWhere(undefined, true), undefined);
  assert.equal(buildAggregateWhere('Type=="ACCPAY"', true), 'Type=="ACCPAY"');
});
