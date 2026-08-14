import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_PRONE,
  collectionOf,
  isCreate,
  unwrapItems,
  naturalKeyOf,
  findAccountCodeViolations,
  existsFilterFor,
  readExisting,
  blocksCreate,
} from './write-guard.js';

// Cases below are taken from the real 2026-08-14 CFO census, not invented shapes.

test('collectionOf normalises the paths xero_request actually receives', () => {
  assert.equal(collectionOf('/Invoices'), 'invoices');
  assert.equal(collectionOf('Invoices'), 'invoices');
  assert.equal(collectionOf('/BankTransactions/abc-123'), 'banktransactions');
});

test('isCreate: POST to a bare duplicate-prone collection is a create', () => {
  assert.equal(isCreate('POST', '/Invoices'), true);
  assert.equal(isCreate('POST', '/BankTransactions'), true);
  assert.equal(isCreate('POST', '/CreditNotes'), true);
});

test('isCreate: an UPDATE of a known object is NOT a duplicate risk', () => {
  // POST /Invoices/{guid} targets one existing object -- blocking it would break legitimate edits.
  assert.equal(isCreate('POST', '/Invoices/0e79cc61-cc39-4c7b-b1f2-5a50ca30137e'), false);
  assert.equal(isCreate('PUT', '/Invoices'), false);
  assert.equal(isCreate('DELETE', '/Invoices'), false);
  assert.equal(isCreate('POST', '/Contacts'), false, 'contacts are not duplicate-prone here');
});

test('unwrapItems handles the plural-key envelope Xero requires', () => {
  const items = unwrapItems({ Invoices: [{ Reference: 'QBO-Bill-22838' }, { Reference: 'QBO-Bill-23119' }] });
  assert.equal(items.length, 2);
  assert.equal(items[0].Reference, 'QBO-Bill-22838');
});

test('naturalKeyOf finds the importer Reference the duplicates all shared', () => {
  assert.deepEqual(naturalKeyOf({ Reference: 'QBO-Bill-22838' }), { field: 'Reference', value: 'QBO-Bill-22838' });
  assert.deepEqual(naturalKeyOf({ InvoiceNumber: 'INV-001' }), { field: 'InvoiceNumber', value: 'INV-001' });
  assert.equal(naturalKeyOf({ Total: 11000 }), null, 'no key -> unverifiable, caller must refuse');
  assert.equal(naturalKeyOf({ Reference: '   ' }), null, 'whitespace is not a key');
});

test('THE CROSS-ORG BUG: a line item with AccountCode and no AccountID is a violation', () => {
  // The real case: code 1251 is "Due from HearingAssist Inc" in INND but "Star Funding - AR" in HA.
  const v = findAccountCodeViolations({
    Invoices: [{ Reference: 'QBO-Transfer-9', LineItems: [{ AccountCode: '1251', Description: 'Due from HearingAssist Inc' }] }],
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].accountCode, '1251');
  assert.equal(v[0].itemIndex, 0);
  assert.equal(v[0].lineIndex, 0);
});

test('CONTROL: AccountID is accepted, and AccountID wins even if a code is also present', () => {
  assert.equal(findAccountCodeViolations({ Invoices: [{ LineItems: [{ AccountID: 'b1d40a69-d6f4-4f05-aeb2-22da568d98f5' }] }] }).length, 0);
  assert.equal(
    findAccountCodeViolations({ Invoices: [{ LineItems: [{ AccountCode: '1251', AccountID: 'b1d40a69-d6f4-4f05-aeb2-22da568d98f5' }] }] }).length,
    0,
    'an explicit AccountID makes the destination unambiguous',
  );
});

test('every violation is reported, not just the first', () => {
  const v = findAccountCodeViolations({
    BankTransactions: [
      { LineItems: [{ AccountCode: '1159' }, { AccountCode: '1155' }] },
      { LineItems: [{ AccountCode: '1251' }] },
    ],
  });
  assert.equal(v.length, 3, 'caller sees the whole set to fix in one refusal');
});

test('existsFilterFor escapes quotes so a reference cannot break the predicate', () => {
  assert.equal(existsFilterFor({ field: 'Reference', value: 'QBO-Bill-22838' }), 'Reference=="QBO-Bill-22838"');
  assert.equal(existsFilterFor({ field: 'Reference', value: 'a"b' }), 'Reference=="a\\"b"');
});

test('REGRESSION (CodeQL): backslashes are escaped BEFORE quotes', () => {
  // The first version escaped only quotes. A value already containing a backslash then turned that
  // backslash into an escape for the quote the function appends, closing the string early:
  //   'a\"b'  ->  Reference=="a\\"b"   (malformed / injectable)
  // A malformed predicate does not fail loudly here -- it returns the WRONG existence answer, and a
  // false "no existing object" is exactly how a duplicate gets created.
  assert.equal(existsFilterFor({ field: 'Reference', value: 'a\\"b' }), 'Reference=="a\\\\\\"b"');
  assert.equal(existsFilterFor({ field: 'Reference', value: 'trailing\\' }), 'Reference=="trailing\\\\"');

  // Structural invariant: every backslash and quote in the emitted value is escaped, so the closing
  // delimiter can never be consumed by a dangling escape.
  const emitted = existsFilterFor({ field: 'Reference', value: 'x\\y"z\\' });
  const inner = emitted.slice('Reference=="'.length, -1);
  assert.equal(inner.replace(/\\\\/g, '').replace(/\\"/g, '').includes('\\'), false, 'no unescaped backslash survives');
  assert.equal(inner.replace(/\\\\/g, '').replace(/\\"/g, '').includes('"'), false, 'no unescaped quote survives');
});

test('readExisting pulls the id/status pairs the refusal message cites', () => {
  const rows = readExisting('invoices', {
    Invoices: [
      { InvoiceID: '0e79cc61-cc39-4c7b-b1f2-5a50ca30137e', Status: 'VOIDED' },
      { InvoiceID: 'ff166836-99b6-450c-907d-7487972b6a06', Status: 'VOIDED' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'VOIDED');
});

test('CRITICAL: VOIDED objects still block a re-create', () => {
  // 74 of the 113 census objects were VOIDED. Re-creating against a voided copy is exactly how one
  // bill reached four objects, so treating VOIDED as "absent" would reproduce the incident.
  assert.equal(blocksCreate(['VOIDED']), true);
  assert.equal(blocksCreate(['DELETED']), true);
  assert.equal(blocksCreate(['AUTHORISED']), true);
  assert.equal(blocksCreate([]), false, 'genuinely absent -> the create proceeds');
});

test('the duplicate-prone set covers exactly the object types the census found multiplied', () => {
  for (const c of ['invoices', 'banktransactions', 'creditnotes']) assert.ok(DUPLICATE_PRONE.has(c));
});
