import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_PRONE,
  collectionOf,
  isCreate,
  unwrapItems,
  naturalKeyOf,
  manualJournalTotal,
  manualJournalKeyGaps,
  manualJournalMatches,
  parseXeroDate,
  findAccountCodeViolations,
  existsFilterFor,
  readExisting,
  blocksCreate,
  isAttachmentPath,
  attachmentWriteRefusal,
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
  assert.deepEqual(naturalKeyOf({ Reference: 'QBO-Bill-22838' }), { kind: 'field', field: 'Reference', value: 'QBO-Bill-22838' });
  assert.deepEqual(naturalKeyOf({ InvoiceNumber: 'INV-001' }), { kind: 'field', field: 'InvoiceNumber', value: 'INV-001' });
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

// ── FND-20260902-3ab8: the guard only ever inspected LineItems, so ManualJournals (which use
// JournalLines instead) and the bare Account-reference fields on BankTransfers/BankTransactions/
// Payments (which have no LineItems array at all) passed unguarded. Extends the SAME function
// rather than forking a second one, per the finding's own instruction. ──────────────────────────

test('THE RESIDUAL BUG (FND-20260902-3ab8): a ManualJournal JournalLine coded by AccountCode (not AccountID) is a violation, same as an Invoice LineItem', () => {
  // Same real code from the header incident: 1251 is "Due from HearingAssist Inc" in INND but
  // "Star Funding - AR" in HearingAssist. A close posts corrections as manual journals constantly,
  // and a ManualJournal has no Reference for the duplicate-create check to key on -- until this fix,
  // NOTHING stood between an AccountCode-only journal and the wrong ledger.
  const v = findAccountCodeViolations({
    ManualJournals: [
      {
        Narration: 'Reclass to Due from HearingAssist Inc',
        Date: '2022-01-31',
        JournalLines: [
          { LineAmount: 1500.5, AccountCode: '1251' },
          { LineAmount: -1500.5, AccountCode: '2000' },
        ],
      },
    ],
  });
  assert.equal(v.length, 2, 'both coded lines are reported');
  assert.equal(v[0].itemIndex, 0);
  assert.equal(v[0].field, 'JournalLines');
  assert.equal(v[0].lineIndex, 0);
  assert.equal(v[0].codeField, 'AccountCode');
  assert.equal(v[0].accountCode, '1251');
  assert.equal(v[1].lineIndex, 1);
  assert.equal(v[1].accountCode, '2000');
});

test('a manual journal whose lines are identified by AccountID (already mapped to the destination org) passes cleanly -- a Code may also be present, AccountID wins', () => {
  // The safe shape the refusal above tells the caller to send: 1251 already resolved to the
  // CORRECT AccountID in the destination org before the journal was posted.
  assert.equal(
    findAccountCodeViolations({
      ManualJournals: [
        {
          JournalLines: [
            { LineAmount: 1500.5, AccountID: 'ha-acct-guid-1' },
            { LineAmount: -1500.5, AccountCode: '2000', AccountID: 'ha-acct-guid-2' },
          ],
        },
      ],
    }).length,
    0,
  );
});

test('a write body mixing an Invoice LineItems violation and a ManualJournal JournalLines violation reports BOTH, in item order', () => {
  // Proves LINE_ARRAY_FIELDS is scanned in full for every item, not "the first array field found" --
  // the exact class of bug unwrapItems's own header (item 1 above) already warns about elsewhere.
  const v = findAccountCodeViolations([
    { LineItems: [{ AccountCode: '1159' }] },
    { JournalLines: [{ AccountCode: '1251' }] },
  ]);
  assert.equal(v.length, 2);
  assert.equal(v[0].itemIndex, 0);
  assert.equal(v[0].field, 'LineItems');
  assert.equal(v[1].itemIndex, 1);
  assert.equal(v[1].field, 'JournalLines');
});

test('a BankTransaction whose own BankAccount leg is identified by Code (not AccountID) is a violation, independent of its LineItems', () => {
  const v = findAccountCodeViolations({
    BankTransactions: [{ Type: 'SPEND', BankAccount: { Code: '090' }, LineItems: [{ AccountID: 'exp-acct-1' }] }],
  });
  assert.equal(v.length, 1, 'the LineItems entry is clean (AccountID) -- only the BankAccount leg is flagged');
  assert.equal(v[0].itemIndex, 0);
  assert.equal(v[0].field, 'BankAccount');
  assert.equal(v[0].lineIndex, undefined, 'a bare reference field has no array index');
  assert.equal(v[0].codeField, 'Code');
  assert.equal(v[0].accountCode, '090');
});

test('CONTROL: a BankAccount identified by AccountID is not a violation, even alongside a Code', () => {
  assert.equal(
    findAccountCodeViolations({ BankTransactions: [{ BankAccount: { AccountID: 'bank-1', Code: '090' } }] }).length,
    0,
  );
});

test('a Payment whose Account is identified by Code (not AccountID) is a violation', () => {
  const v = findAccountCodeViolations({ Payments: [{ Account: { Code: '090' }, Amount: 500 }] });
  assert.equal(v.length, 1);
  assert.equal(v[0].field, 'Account');
  assert.equal(v[0].codeField, 'Code');
  assert.equal(v[0].accountCode, '090');
});

test('a BankTransfer with BOTH legs identified by Code (not AccountID) reports both violations -- a BankTransfer has no LineItems at all, so before this fix it had ZERO coverage', () => {
  const v = findAccountCodeViolations({
    BankTransfers: [{ FromBankAccount: { Code: '090' }, ToBankAccount: { Code: '091' }, Amount: 100 }],
  });
  assert.equal(v.length, 2);
  assert.deepEqual(
    v.map((x) => x.field).sort(),
    ['FromBankAccount', 'ToBankAccount'],
  );
});

test('CONTROL: a BankTransfer with both legs identified by AccountID is not a violation', () => {
  assert.equal(
    findAccountCodeViolations({
      BankTransfers: [{ FromBankAccount: { AccountID: 'a-1' }, ToBankAccount: { AccountID: 'a-2' } }],
    }).length,
    0,
  );
});

test('a non-object, array, or whitespace-only value in an Account-reference field is ignored, not a false positive', () => {
  assert.equal(findAccountCodeViolations({ Payments: [{ Account: 'not-an-object' }] }).length, 0);
  assert.equal(findAccountCodeViolations({ Payments: [{ Account: ['nope'] }] }).length, 0);
  assert.equal(findAccountCodeViolations({ Payments: [{ Account: { Code: '   ' } }] }).length, 0, 'whitespace-only Code is not a violation');
});

test('COUNTERFACTUAL: the pre-fix (LineItems-only) scan would have missed this exact ManualJournal violation, so the write would have been attempted', () => {
  // Reconstructed from write-guard.ts's original findAccountCodeViolations (pre FND-20260902-3ab8),
  // which walked ONLY `LineItems`. A ManualJournal never carries that field -- it uses JournalLines
  // -- so the pre-fix scan always scored zero violations against one, regardless of what its lines
  // were actually coded by. With zero violations, handleXeroRequest's step 1 never refuses, so
  // execution falls through to step 2 (the duplicate-create probe) and, once that passes, to the
  // real xeroRequest call -- i.e. the write is attempted, which is the exact defect this guard
  // exists to prevent.
  function preFixScan(body: unknown): number {
    let count = 0;
    unwrapItems(body).forEach((item) => {
      const lines = item['LineItems'];
      if (!Array.isArray(lines)) return;
      for (const line of lines) {
        if (!line || typeof line !== 'object') continue;
        const l = line as Record<string, unknown>;
        const code = l['AccountCode'];
        const id = l['AccountID'] ?? l['AccountId'];
        if (code !== undefined && code !== null && String(code).trim() !== '' && !id) count++;
      }
    });
    return count;
  }
  const body = {
    ManualJournals: [
      { Narration: 'n', Date: '2022-01-31', JournalLines: [{ LineAmount: 100, AccountCode: '1251' }] },
    ],
  };
  assert.equal(preFixScan(body), 0, 'the pre-fix scan never looks at JournalLines at all, so it sees zero violations here');
  assert.equal(findAccountCodeViolations(body).length, 1, 'the fixed scan catches it');

  // Same counterfactual for the bare Account-reference fields: a BankTransfer has no LineItems at
  // all, so the pre-fix scan saw zero violations on EVERY BankTransfer body, unconditionally.
  const transfer = { BankTransfers: [{ FromBankAccount: { Code: '090' }, ToBankAccount: { Code: '091' } }] };
  assert.equal(preFixScan(transfer), 0, 'a BankTransfer has no LineItems, so the pre-fix scan never had any coverage of it');
  assert.equal(findAccountCodeViolations(transfer).length, 2, 'the fixed scan catches both legs');
});

test('existsFilterFor escapes quotes so a reference cannot break the predicate', () => {
  assert.equal(existsFilterFor({ kind: 'field' as const, field: 'Reference', value: 'QBO-Bill-22838' }), 'Reference=="QBO-Bill-22838"');
  assert.equal(existsFilterFor({ kind: 'field' as const, field: 'Reference', value: 'a"b' }), 'Reference=="a\\"b"');
});

test('REGRESSION (CodeQL): backslashes are escaped BEFORE quotes', () => {
  // The first version escaped only quotes. A value already containing a backslash then turned that
  // backslash into an escape for the quote the function appends, closing the string early:
  //   'a\"b'  ->  Reference=="a\\"b"   (malformed / injectable)
  // A malformed predicate does not fail loudly here -- it returns the WRONG existence answer, and a
  // false "no existing object" is exactly how a duplicate gets created.
  assert.equal(existsFilterFor({ kind: 'field' as const, field: 'Reference', value: 'a\\"b' }), 'Reference=="a\\\\\\"b"');
  assert.equal(existsFilterFor({ kind: 'field' as const, field: 'Reference', value: 'trailing\\' }), 'Reference=="trailing\\\\"');

  // Structural invariant: every backslash and quote in the emitted value is escaped, so the closing
  // delimiter can never be consumed by a dangling escape.
  const emitted = existsFilterFor({ kind: 'field' as const, field: 'Reference', value: 'x\\y"z\\' });
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

// ── ManualJournal natural key (2026-08-17, CFO P1: the guard blocked every posting) ──────────────
// A Xero ManualJournal has NO Reference / InvoiceNumber / CreditNoteNumber -- Narration is its only
// descriptor -- so naturalKeyOf returned null for every one and the guard refused them all as
// `unverifiable_create`. Since nearly every correction an accounting close posts IS a manual
// journal, that blocked the FY2022 remediation programme outright. Narration + Date + Total is the
// key the CFO's own duplicate census grouped on when it found 17 duplicate journal groups.

const JOURNAL = {
  Narration: 'Reclass derivative liability, note 4',
  Date: '2022-01-31',
  JournalLines: [
    { LineAmount: 1500.5, AccountID: 'a-1' },
    { LineAmount: -1500.5, AccountID: 'a-2' },
  ],
};

test('manualJournalTotal sums the DEBIT side, not the whole balanced array', () => {
  // Summing everything gives ~0 for any balanced journal, which would make every journal look
  // identical and destroy the key's discriminating power.
  assert.equal(manualJournalTotal(JOURNAL), 1500.5);
  assert.equal(
    manualJournalTotal({ JournalLines: [{ LineAmount: 10 }, { LineAmount: 5 }, { LineAmount: -15 }] }),
    15,
  );
});

test('manualJournalTotal accepts numeric strings and rejects unusable line data', () => {
  assert.equal(manualJournalTotal({ JournalLines: [{ LineAmount: '99.99' }, { LineAmount: '-99.99' }] }), 99.99);
  // No lines, or no parseable amount, must yield null so the caller REFUSES rather than keying on
  // a silently-wrong 0 -- a false "no existing object" is how a duplicate gets created.
  assert.equal(manualJournalTotal({ JournalLines: [] }), null);
  assert.equal(manualJournalTotal({ JournalLines: [{ LineAmount: 'abc' }] }), null);
  assert.equal(manualJournalTotal({}), null);
});

test('parseXeroDate handles both the ISO form and Xero own /Date(ms)/ read serialization', () => {
  assert.deepEqual(parseXeroDate('2022-01-31'), { y: 2022, m: 1, d: 31 });
  assert.deepEqual(parseXeroDate('2022-01-31T00:00:00'), { y: 2022, m: 1, d: 31 });
  // 1643587200000 = 2022-01-31T00:00:00Z. Parsed as UTC on purpose: local parts would shift the
  // date across a day boundary outside UTC, turning a correct probe into a miss.
  assert.deepEqual(parseXeroDate('/Date(1643587200000)/'), { y: 2022, m: 1, d: 31 });
  assert.equal(parseXeroDate(''), null);
  assert.equal(parseXeroDate(undefined), null);
});

test('naturalKeyOf builds a composite key for manualjournals, and only for manualjournals', () => {
  const key = naturalKeyOf(JOURNAL, 'manualjournals');
  assert.equal(key?.kind, 'manual_journal');
  assert.equal(key?.field, 'Narration+Date+Total');
  assert.match(String(key?.value), /Reclass derivative liability, note 4 @ 2022-01-31 total 1500\.50/);
  // The same object on another collection has no key at all -- the composite must not leak into
  // collections where Reference is the real key.
  assert.equal(naturalKeyOf(JOURNAL, 'invoices'), null);
  assert.equal(naturalKeyOf(JOURNAL), null);
});

test('naturalKeyOf refuses a PARTIAL manual-journal key rather than probing on a weaker one', () => {
  // A partial key probes on a broader predicate: it either matches an unrelated journal and blocks
  // a legitimate post, or misses the discriminating part and lets a real duplicate through.
  assert.equal(naturalKeyOf({ ...JOURNAL, Narration: '   ' }, 'manualjournals'), null);
  assert.equal(naturalKeyOf({ ...JOURNAL, Date: undefined }, 'manualjournals'), null);
  assert.equal(naturalKeyOf({ ...JOURNAL, JournalLines: [] }, 'manualjournals'), null);
});

test('manualJournalKeyGaps names exactly what is missing, so the refusal is actionable', () => {
  assert.deepEqual(manualJournalKeyGaps(JOURNAL), []);
  assert.deepEqual(manualJournalKeyGaps({ Date: '2022-01-31', JournalLines: [{ LineAmount: 1 }] }), [
    'Narration (non-empty)',
  ]);
  const all = manualJournalKeyGaps({});
  assert.equal(all.length, 3, 'an empty journal should report all three missing parts');
});

test('existsFilterFor renders a Narration + Date predicate and escapes the narration', () => {
  const key = naturalKeyOf(JOURNAL, 'manualjournals')!;
  assert.equal(
    existsFilterFor(key),
    'Narration=="Reclass derivative liability, note 4" && Date==DateTime(2022,01,31)',
  );
  // Total is deliberately absent: Xero has no filterable Total field on ManualJournal.
  assert.equal(existsFilterFor(key).includes('Total'), false);
  const quoted = naturalKeyOf({ ...JOURNAL, Narration: 'a\\"b' }, 'manualjournals')!;
  // Backslash escaped BEFORE the quote, same invariant the Reference path relies on: a wrong
  // predicate does not fail loudly, it returns the wrong existence answer.
  assert.equal(existsFilterFor(quoted).startsWith('Narration=="a\\\\\\"b"'), true);
});

test('manualJournalMatches compares in cents with tolerance, not by float equality', () => {
  assert.equal(manualJournalMatches(1500.5, 1500.5), true);
  assert.equal(manualJournalMatches(1500.5, 1500.51), true, '1 cent is within tolerance');
  assert.equal(manualJournalMatches(1500.5, 1500.75), false);
  // A journal whose lines Xero did not return cannot be compared, so it must NOT count as a match:
  // treating unknown as "same" would block a legitimate post.
  assert.equal(manualJournalMatches(null, 1500.5), false);
  // Float representation must not split an identical journal.
  assert.equal(manualJournalMatches(0.1 + 0.2, 0.3), true);
});

test('readExisting surfaces the total for manualjournals and leaves it null elsewhere', () => {
  const body = {
    ManualJournals: [
      { ManualJournalID: 'mj-1', Status: 'POSTED', JournalLines: [{ LineAmount: 1500.5 }, { LineAmount: -1500.5 }] },
    ],
  };
  assert.deepEqual(readExisting('manualjournals', body), [{ id: 'mj-1', status: 'POSTED', total: 1500.5 }]);
  const inv = { Invoices: [{ InvoiceID: 'inv-1', Status: 'AUTHORISED' }] };
  assert.deepEqual(readExisting('invoices', inv), [{ id: 'inv-1', status: 'AUTHORISED', total: null }]);
});

// ── unwrapItems: a bare entity is not a wrapper (2026-08-17, CFO reproduction) ───────────────────
// The old implementation returned the FIRST array-valued property, so a manual journal sent bare as
// `{Narration, Date, JournalLines:[...]}` had its LINE ITEMS unwrapped as if they were the journals.
// The key check then looked for a Narration on each LINE, found none, and refused a valid create as
// `unverifiable_create`. This was never manual-journal-specific: any bare entity with a nested array
// (an invoice's LineItems, for instance) hit it.
test('unwrapItems: a bare entity with a nested array is ONE item, not its line items', () => {
  const bare = { Narration: 'n', Date: '2022-01-31', JournalLines: [{ LineAmount: 1 }, { LineAmount: -1 }] };
  const items = unwrapItems(bare, 'manualjournals');
  assert.equal(items.length, 1, 'the journal itself, not its two lines');
  assert.equal(items[0].Narration, 'n');
  // And the key must therefore build, which is the behaviour the CFO could not get.
  assert.equal(naturalKeyOf(items[0], 'manualjournals')?.kind, 'manual_journal');
});

test('unwrapItems: the collection-named wrapper still wins, and so does a single-key wrapper', () => {
  const wrapped = { ManualJournals: [{ Narration: 'a' }, { Narration: 'b' }] };
  assert.equal(unwrapItems(wrapped, 'manualjournals').length, 2);
  // Same shape with the collection NOT supplied: a single-key object is still a wrapper.
  assert.equal(unwrapItems(wrapped).length, 2);
  // An invoice carrying LineItems must not unwrap to its lines either.
  const inv = { Reference: 'QBO-Bill-1', LineItems: [{ LineAmount: 5 }] };
  assert.deepEqual(unwrapItems(inv, 'invoices'), [inv]);
});

test('unwrapItems: a bare ARRAY body is accepted', () => {
  assert.equal(unwrapItems([{ Narration: 'a' }, { Narration: 'b' }], 'manualjournals').length, 2);
});

// ── parseXeroDate: accept the unambiguous forms, REFUSE the ambiguous one ────────────────────────
test('parseXeroDate accepts unpadded ISO, Date instances and epoch numbers', () => {
  assert.deepEqual(parseXeroDate('2022-1-31'), { y: 2022, m: 1, d: 31 }, 'a leading zero is not a safety property');
  assert.deepEqual(parseXeroDate(new Date(Date.UTC(2022, 0, 31))), { y: 2022, m: 1, d: 31 });
  assert.deepEqual(parseXeroDate(Date.UTC(2022, 0, 31)), { y: 2022, m: 1, d: 31 });
});

test('parseXeroDate REFUSES a slash date, deliberately, because it is ambiguous', () => {
  // 01/02/2022 is 2 January in the US and 1 February elsewhere. This value is half a
  // duplicate-detection key, so guessing means probing for the WRONG journal, finding nothing, and
  // letting a duplicate through -- the exact failure the guard exists to prevent. Refusing loudly
  // and naming the accepted format is the safer trade.
  assert.equal(parseXeroDate('01/02/2022'), null);
  assert.equal(parseXeroDate('01/31/2022'), null);
});

test('the refusal NAMES the accepted date formats, so a slash date is self-diagnosable', () => {
  const gaps = manualJournalKeyGaps({ Narration: 'n', Date: '01/31/2022', JournalLines: [{ LineAmount: 1 }] });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /YYYY-MM-DD/);
  assert.match(gaps[0], /slash date/, 'the caller cannot guess the cause from "missing Date"');
});

// ── isAttachmentPath / attachmentWriteRefusal: the residual FND-20260724-f6df gap ────────────────
//
// The original finding fixed xero_attachment_upload (xeroUploadAttachment sends the file's real
// bytes with its real Content-Type). It did NOT stop xero_request from reaching the exact same
// Attachments sub-resource with a JSON body -- xeroRequest() (client.ts) always JSON.stringify()s
// its body and always sends Content-Type: application/json, regardless of path. Before this guard,
// a caller could POST/PUT "/ManualJournals/{guid}/Attachments/{fileName}" through xero_request and
// silently reproduce the identical false-success defect (a plausible 200 + AttachmentID with
// nothing actually persisted) that xero_attachment_upload was built to fix. These tests pin the
// detection logic; tools.test.ts pins that the handler actually consults it before any network I/O.

test('isAttachmentPath: recognizes the real Xero Attachments URL shape, with and without a filename', () => {
  assert.equal(isAttachmentPath('/ManualJournals/journal-1/Attachments/statement.pdf'), true);
  assert.equal(isAttachmentPath('/Invoices/inv-1/Attachments'), true, 'the listing shape (no filename) still targets the sub-resource');
  assert.equal(isAttachmentPath('ManualJournals/journal-1/Attachments/statement.pdf'), true, 'a missing leading slash does not defeat detection');
});

test('isAttachmentPath: case-insensitive, so a casing slip cannot fall through to a live write', () => {
  assert.equal(isAttachmentPath('/Invoices/inv-1/attachments/statement.pdf'), true);
  assert.equal(isAttachmentPath('/Invoices/inv-1/ATTACHMENTS/statement.pdf'), true);
});

test('isAttachmentPath: ordinary accounting paths (no Attachments segment) are NOT flagged', () => {
  assert.equal(isAttachmentPath('/Invoices'), false);
  assert.equal(isAttachmentPath('/Invoices/inv-1'), false);
  assert.equal(isAttachmentPath('/ManualJournals'), false);
  assert.equal(isAttachmentPath('/Contacts/contact-1'), false);
});

test('isAttachmentPath: a filename that merely CONTAINS "attachments" does not falsely match a whole segment', () => {
  // Guards against a naive substring check -- only a path SEGMENT exactly equal to "attachments"
  // (case-insensitively) counts; "my-attachments-log.pdf" is an ordinary filename on some other
  // endpoint's sub-resource, not the Attachments API itself.
  assert.equal(isAttachmentPath('/Invoices/inv-1/Notes/my-attachments-log.pdf'), false);
});

test('attachmentWriteRefusal: POST to an Attachments sub-resource is refused with the actionable error code', () => {
  const result = attachmentWriteRefusal('POST', '/ManualJournals/journal-1/Attachments/statement.pdf');
  assert.ok(result, 'a POST to an Attachments path must be refused, not allowed through');
  assert.equal(result?.error, 'use_xero_attachment_upload');
  assert.match(result!.summary, /REFUSED/);
  assert.match(result!.summary, /xero_attachment_upload/);
  assert.match(result!.summary, /FND-20260724-f6df/);
});

test('attachmentWriteRefusal: PUT to an Attachments sub-resource is refused the same way (Xero documents PUT for attachment upload)', () => {
  const result = attachmentWriteRefusal('PUT', '/Invoices/inv-1/Attachments/receipt.png');
  assert.equal(result?.error, 'use_xero_attachment_upload');
});

test('attachmentWriteRefusal: method comparison is case-insensitive, matching isCreate\'s existing convention', () => {
  const result = attachmentWriteRefusal('post', '/Invoices/inv-1/Attachments/receipt.png');
  assert.equal(result?.error, 'use_xero_attachment_upload');
});

test('attachmentWriteRefusal: DELETE is NOT gated -- it carries no body, so it cannot trigger the JSON-vs-bytes mismatch', () => {
  assert.equal(attachmentWriteRefusal('DELETE', '/Invoices/inv-1/Attachments/receipt.png'), null);
});

test('attachmentWriteRefusal: an ordinary (non-Attachments) POST/PUT/DELETE is never refused by this guard', () => {
  assert.equal(attachmentWriteRefusal('POST', '/Invoices'), null);
  assert.equal(attachmentWriteRefusal('PUT', '/Invoices/inv-1'), null);
  assert.equal(attachmentWriteRefusal('DELETE', '/ManualJournals/journal-1'), null);
});
