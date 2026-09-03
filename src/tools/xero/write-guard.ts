/**
 * Xero write guard — the duplicate-object and cross-org-mapping defences for `xero_request`.
 *
 * WHY THIS EXISTS (live incident, 2026-08-14, CFO lane). A census of HearingAssist December-2022
 * accounts payable found 113 objects representing only 25 distinct bills: 49 phantom duplicates,
 * 13 bills existing as FOUR separate objects each. Two write waves (2026-06-29 and 2026-08-12)
 * were visible in UpdatedDateUTC, i.e. the duplication was still generating objects during the
 * FY2022 close. Gateway logs attributed the writes to `xero_request`, which until now went
 * straight from its dry-run check to the HTTP call with NO duplicate protection of any kind:
 * no idempotency key, no read-before-write, no existence check on Reference.
 *
 * The same census found cross-entity contamination: one source document landing in BOTH the INND
 * and HearingAssist ledgers, because the importer wrote an `AccountCode` rather than an
 * `AccountID`. Codes are per-org. Code 1251 is "Due from HearingAssist Inc" in INND but
 * "Star Funding - AR" in HearingAssist, so Xero silently re-resolved the code into an unrelated
 * account in the destination org. A contact literally named "Due from HearingAssist Inc" was
 * created INSIDE HearingAssist. Account codes also collide across banks (1159 is INND Brex 8750
 * but HA BB&T 6132).
 *
 * DESIGN NOTES
 *  - FAIL CLOSED. If the existence probe cannot be completed, the write is REFUSED, not allowed.
 *    During an integrity incident an unverifiable write is worse than a delayed one. The caller
 *    gets exact text explaining which probe failed.
 *  - EXPLICIT OVERRIDE, never a silent bypass. `allow_duplicate: true` is the only way past the
 *    duplicate check and it is recorded in the response summary, so a deliberate second object
 *    stays possible but never accidental.
 *  - PURE CORE. Everything here except the probe itself is a pure function over the request body,
 *    so the whole matrix is unit-testable without touching Xero.
 */

/** Accounting collections where a duplicate object is a real accounting defect rather than noise.
 *  These are the exact types the census found multiplied (ACCPAY invoices, bank transactions,
 *  ACCPAYCREDIT credit notes) plus manual journals, which the importer also emits. */
export const DUPLICATE_PRONE = new Set(['invoices', 'banktransactions', 'creditnotes', 'manualjournals']);

/** Normalise "/Invoices", "Invoices", "/Invoices/{guid}" -> "invoices". */
export function collectionOf(path: string): string {
  const first = path.replace(/^\/+/, '').split('/')[0] ?? '';
  return first.toLowerCase();
}

/** True when this call is a create against a duplicate-prone collection. A PUT/POST to a specific
 *  object id (/Invoices/{guid}) is an UPDATE of a known object and is not a duplicate risk. */
export function isCreate(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const segments = path.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segments.length !== 1) return false;
  return DUPLICATE_PRONE.has(collectionOf(path));
}

/** The items a Xero accounting write carries, unwrapped from its plural key
 *  ({"Invoices":[{...}]}). Returns [] for shapes this guard does not understand, which the caller
 *  treats as "cannot verify" rather than "nothing to check". */
export function unwrapItems(body: unknown, collection?: string): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return [];
  const objects = (arr: unknown[]) => arr.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>;
  // A bare array body.
  if (Array.isArray(body)) return objects(body);
  const obj = body as Record<string, unknown>;

  // 1. THE COLLECTION-NAMED WRAPPER WINS. Previously this function returned the FIRST array-valued
  //    property it found, which silently unwrapped the WRONG level for a bare entity: a manual
  //    journal sent as `{Narration, Date, JournalLines:[...]}` had its LINE ITEMS returned as if
  //    they were the journals, so the key check looked for a Narration on each line, found none,
  //    and refused a perfectly valid create as `unverifiable_create`. The same shape breaks any
  //    bare entity carrying a nested array -- an invoice's LineItems, for instance -- so this was
  //    never a manual-journal-only defect.
  if (collection) {
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === collection.toLowerCase() && Array.isArray(v)) return objects(v);
    }
  }
  // 2. A single-key object IS a wrapper (`{ManualJournals:[...]}`) even when the caller did not tell
  //    us the collection. More than one key means the array is a FIELD of an entity, not a wrapper.
  const keys = Object.keys(obj);
  if (keys.length === 1 && Array.isArray(obj[keys[0]])) return objects(obj[keys[0]] as unknown[]);

  // 3. A bare single entity (Xero accepts this on some endpoints).
  return keys.length ? [obj] : [];
}

/**
 * A natural key the guard can probe for. Two shapes:
 *
 *  - `field`          a single Xero field with an exact value (Reference / InvoiceNumber /
 *                     CreditNoteNumber). The census duplicates all carried the importer's
 *                     `Reference` (QBO-Bill-NNNNN / QBO-Transfer-id), which is what a dedupe
 *                     should key on.
 *  - `manual_journal` a COMPOSITE of Narration + Date + Total, because a Xero ManualJournal has no
 *                     Reference, InvoiceNumber or CreditNoteNumber -- Narration is its only
 *                     descriptor. Before this existed the guard had no key to probe on a manual
 *                     journal and refused every one as `unverifiable_create`, which blocked the
 *                     FY2022 remediation programme outright, since nearly every correction a close
 *                     posts IS a manual journal.
 *
 * `field`/`value` are carried on BOTH shapes so refusal messages and probe-failure messages can
 * render any key uniformly without knowing its kind.
 */
export type NaturalKey =
  | { kind: 'field'; field: string; value: string }
  | {
      kind: 'manual_journal';
      field: string;
      value: string;
      narration: string;
      date: { y: number; m: number; d: number };
      total: number;
    };

/**
 * Journal total = the sum of the POSITIVE line amounts, i.e. the debit side.
 *
 * A balanced journal has debits equal to credits, so summing the whole array yields ~0 and would
 * make every journal look identical -- useless as a key discriminator. Summing one side gives the
 * journal's magnitude, which is what "Total" means to an accountant reading it.
 *
 * Returns null when there is no usable line data, so the caller refuses rather than keying on a
 * silently-wrong 0 (a false "no existing object" is exactly how a duplicate gets created).
 */
export function manualJournalTotal(item: Record<string, unknown>): number | null {
  const lines = item['JournalLines'];
  if (!Array.isArray(lines) || !lines.length) return null;
  let sum = 0;
  let sawNumber = false;
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const raw = (line as Record<string, unknown>)['LineAmount'];
    // Xero returns amounts as numbers, but hand-built payloads routinely carry numeric strings.
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(n)) continue;
    sawNumber = true;
    if (n > 0) sum += n;
  }
  return sawNumber ? Math.round(sum * 100) / 100 : null;
}

/**
 * Parse a Xero date into calendar parts for a `DateTime(y,m,d)` predicate.
 *
 * Accepts an ISO-ish string ("2022-01-31", "2022-01-31T00:00:00") and Xero's own
 * "/Date(1643587200000)/" serialization, which is what comes back on a read and therefore what a
 * caller round-tripping an existing journal will hand us.
 */
export function parseXeroDate(raw: unknown): { y: number; m: number; d: number } | null {
  // A Date instance, or an epoch number, both of which a caller building a payload in code will
  // produce naturally. UTC parts on purpose -- local parts shift the date across a day boundary
  // outside UTC, and a wrong date in the key probes for the wrong journal.
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { y: raw.getUTCFullYear(), m: raw.getUTCMonth() + 1, d: raw.getUTCDate() };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  // Unpadded ISO is accepted ("2022-1-31"): it is unambiguous, and refusing it just to insist on a
  // leading zero blocks a valid post for no safety gain.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  // DELIBERATELY NOT ACCEPTED: slash dates (01/02/2022). US MM/DD and international DD/MM are
  // indistinguishable, so accepting them means GUESSING which of two real dates the caller meant.
  // This value is half a duplicate-detection key: a wrong date probes for the wrong journal, finds
  // nothing, and lets a duplicate through -- the exact failure this guard exists to prevent. A loud
  // refusal naming the accepted format is strictly better than a silent coin flip.
  const ms = s.match(/^\/Date\((-?\d+)/);
  if (ms) {
    const dt = new Date(Number(ms[1]));
    if (!Number.isNaN(dt.getTime())) {
      // UTC parts: Xero's epoch serialization is UTC, and using local parts would shift the date
      // across a day boundary for anyone running outside UTC -- turning a correct probe into a
      // miss, which fails OPEN into a duplicate.
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    }
  }
  return null;
}

/** The natural key a duplicate would share, for whichever collection is being written. */
export function naturalKeyOf(item: Record<string, unknown>, collection?: string): NaturalKey | null {
  for (const field of ['Reference', 'InvoiceNumber', 'CreditNoteNumber']) {
    const v = item[field];
    if (typeof v === 'string' && v.trim()) return { kind: 'field', field, value: v.trim() };
  }
  if (collection === 'manualjournals') {
    const narration = typeof item['Narration'] === 'string' ? item['Narration'].trim() : '';
    const date = parseXeroDate(item['Date']);
    const total = manualJournalTotal(item);
    // All three are required. A partial key is worse than none: it would probe on a broader
    // predicate, match an unrelated journal, and refuse a legitimate post -- or, if the missing
    // part is the discriminating one, miss a real duplicate.
    if (!narration || !date || total === null) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      kind: 'manual_journal',
      field: 'Narration+Date+Total',
      value: `${narration} @ ${date.y}-${pad(date.m)}-${pad(date.d)} total ${total.toFixed(2)}`,
      narration,
      date,
      total,
    };
  }
  return null;
}

/**
 * Why a manual-journal key could not be built. Used ONLY to render an actionable refusal -- the
 * guard's decision is already made by naturalKeyOf returning null. Kept separate so the refusal can
 * name the missing part instead of saying "no Reference" on an object that can never have one.
 */
export function manualJournalKeyGaps(item: Record<string, unknown>): string[] {
  const gaps: string[] = [];
  if (!(typeof item['Narration'] === 'string' && item['Narration'].trim())) gaps.push('Narration (non-empty)');
  if (!parseXeroDate(item['Date']))
    gaps.push(
      // Name the ACCEPTED forms, not just the missing field. A slash date is the common miss and the
      // caller cannot guess from "missing Date" that MM/DD/YYYY was the problem.
      `Date (accepted: YYYY-MM-DD, YYYY-M-D, an ISO timestamp, or Xero's /Date(ms)/ -- a slash date ` +
        `like 01/02/2022 is REFUSED as ambiguous, not unsupported)`,
    );
  if (manualJournalTotal(item) === null) gaps.push('JournalLines[].LineAmount (numeric)');
  return gaps;
}

export interface MappingViolation {
  itemIndex: number;
  /** The field on the item carrying this reference: a line-array field (`LineItems` on
   *  Invoices/CreditNotes/BankTransactions/PurchaseOrders/Quotes, `JournalLines` on ManualJournals
   *  -- see LINE_ARRAY_FIELDS) or a bare single-object Account-reference field (`BankAccount`,
   *  `Account`, `FromBankAccount`, `ToBankAccount` -- see ACCOUNT_REF_FIELDS). */
  field: string;
  /** Index within `field` for a line-array violation. Absent (undefined) for a bare single-object
   *  reference field, which has no array to index. */
  lineIndex?: number;
  /** The literal Xero property that carried the code value -- `AccountCode` on a line, `Code` on
   *  an embedded Account-shaped reference object -- so a refusal names the field the caller
   *  actually sent rather than a generic placeholder. */
  codeField: 'AccountCode' | 'Code';
  accountCode: string;
}

/**
 * Line-array fields whose entries identify a GL account by AccountCode. Invoices, CreditNotes,
 * BankTransactions, PurchaseOrders and Quotes all share `LineItems` -- checking it here is
 * COLLECTION-AGNOSTIC by design (findAccountCodeViolations never looks at which top-level
 * collection a body belongs to, only at field shape), which is exactly why those were all already
 * covered without ever being named individually. ManualJournals alone uses `JournalLines` instead
 * of `LineItems` for the identical purpose (see write-guard.test.ts's JOURNAL fixture, which has
 * used JournalLines[].AccountID since before this fix), and until FND-20260902-3ab8 this scan
 * never looked there: a ManualJournal coded entirely by AccountCode reached Xero with NO cross-org
 * check at all -- the exact defect this guard exists to close, on the one collection it never
 * actually inspected. A close posts corrections as manual journals constantly (see the
 * naturalKeyOf/manualJournalKeyGaps history above), so this was not a narrow gap.
 */
const LINE_ARRAY_FIELDS = ['LineItems', 'JournalLines'] as const;

/**
 * Single embedded Account-reference fields a Xero write body carries OUTSIDE any line array, each
 * shaped like the chart-of-accounts Account resource itself ({AccountID, Code, Name, ...} -- see
 * Xero's published OpenAPI schema) and therefore exposed to the IDENTICAL per-org Code ambiguity a
 * line item's AccountCode is: `BankAccount` is a BankTransaction's own bank leg (required on every
 * BankTransaction write, independent of its LineItems); `Account` is a Payment's bank/clearing
 * account; `FromBankAccount`/`ToBankAccount` are a BankTransfer's two legs (a BankTransfer has NO
 * LineItems at all -- see gl-assemble.ts's header on that -- so without this it would have had ZERO
 * account-identity coverage of any kind). Confirmed against Xero's documented BankTransfer and
 * Payment schemas, not a guess. Added during the FND-20260902-3ab8 audit of "every write shape that
 * carries account-coded lines", which named BankTransfers and Payments explicitly.
 *
 * NOT covered here, and deliberately: PurchaseOrders/Quotes need no entry -- they fall under
 * LINE_ARRAY_FIELDS above (they carry LineItems exactly like Invoices, so the existing generic scan
 * already reaches them). Overpayments and Prepayments have NO documented direct create endpoint in
 * Xero's Accounting API -- they arise only as a side effect of a Payment or BankTransaction whose
 * amount exceeds the target, both of which ARE covered above; their own write surface,
 * `.../Allocations`, carries only an Invoice reference by InvoiceID, never an account code, so
 * there is nothing for this guard to check there today. If Xero ever adds a direct create for
 * either, audit it the same way before assuming this list still covers it.
 */
const ACCOUNT_REF_FIELDS = ['BankAccount', 'Account', 'FromBankAccount', 'ToBankAccount'] as const;

/** True when `obj` carries a non-empty AccountID (or the lowercase-d `AccountId` some hand-built
 *  payloads use), which makes its account reference unambiguous regardless of any Code also present. */
function hasAccountId(obj: Record<string, unknown>): boolean {
  const id = obj['AccountID'] ?? obj['AccountId'];
  return id !== undefined && id !== null && String(id).trim() !== '';
}

/**
 * Cross-org mapping defence: a write that identifies an account by CODE cannot be verified as
 * landing in the intended account, because codes are per-org and Xero re-resolves them locally.
 * Require `AccountID` (a GUID, globally unique) instead. Scans every line-array field
 * (LINE_ARRAY_FIELDS) AND every bare Account-reference field (ACCOUNT_REF_FIELDS) on every
 * unwrapped item, so this stays collection-agnostic the same way the original LineItems-only scan
 * was -- a body is checked by field SHAPE, never by which endpoint it is headed to. Returns every
 * violation rather than the first, so one refusal shows the caller the whole set to fix.
 */
export function findAccountCodeViolations(body: unknown): MappingViolation[] {
  const out: MappingViolation[] = [];
  unwrapItems(body).forEach((item, itemIndex) => {
    for (const field of LINE_ARRAY_FIELDS) {
      const lines = item[field];
      if (!Array.isArray(lines)) continue;
      lines.forEach((line, lineIndex) => {
        if (!line || typeof line !== 'object') return;
        const l = line as Record<string, unknown>;
        const code = l['AccountCode'];
        if (code !== undefined && code !== null && String(code).trim() !== '' && !hasAccountId(l)) {
          out.push({ itemIndex, field, lineIndex, codeField: 'AccountCode', accountCode: String(code) });
        }
      });
    }
    for (const field of ACCOUNT_REF_FIELDS) {
      const ref = item[field];
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
      const r = ref as Record<string, unknown>;
      const code = r['Code'];
      if (code !== undefined && code !== null && String(code).trim() !== '' && !hasAccountId(r)) {
        out.push({ itemIndex, field, codeField: 'Code', accountCode: String(code) });
      }
    }
  });
  return out;
}

/**
 * Xero's `where` filter for an exact-Reference existence probe.
 *
 * ESCAPE ORDER MATTERS: backslashes FIRST, then quotes. Escaping only quotes (the first version of
 * this function, caught by CodeQL) is broken, because a value already containing a backslash turns
 * that backslash into an escape for the quote this function adds: the value `a\"b` became
 * `Reference=="a\\"b"`, where `\\` is a literal backslash and the following `"` closes the string
 * early — a malformed predicate at best and a filter-injection at worst. Escaping backslashes
 * first makes each escape stand for exactly one input character.
 *
 * This matters here specifically because a wrong predicate does not fail loudly: it would return
 * the WRONG existence answer, and a false "no existing object" is precisely how a duplicate gets
 * created — the exact defect this guard exists to prevent.
 */
export function existsFilterFor(key: NaturalKey): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (key.kind === 'manual_journal') {
    // Narration + Date only. `Total` is NOT a Xero ManualJournal field -- the amount lives on
    // JournalLines -- so it cannot be filtered server-side and is applied as a client-side refine
    // in manualJournalMatches(). Filtering on the two fields Xero does expose keeps the candidate
    // set small; the total then decides.
    const { y, m, d } = key.date;
    return `Narration=="${esc(key.narration)}" && Date==DateTime(${y},${String(m).padStart(2, '0')},${String(d).padStart(2, '0')})`;
  }
  return `${key.field}=="${esc(key.value)}"`;
}

/**
 * Client-side half of the manual-journal key: does an existing journal carry the same total?
 *
 * Compared in CENTS with a 1-cent tolerance rather than by float equality, because both sides have
 * been through JSON and a rounding step, and `0.1 + 0.2 !== 0.3` would make an identical journal
 * look distinct -- failing OPEN into exactly the duplicate this guard exists to prevent.
 */
export function manualJournalMatches(existingTotal: number | null, keyTotal: number): boolean {
  if (existingTotal === null) return false;
  return Math.abs(Math.round(existingTotal * 100) - Math.round(keyTotal * 100)) <= 1;
}

export interface ExistingHit {
  reference: string;
  ids: string[];
  statuses: string[];
}

/**
 * Pull (id, status) pairs out of a Xero list response for whichever collection was probed.
 *
 * `total` is populated for manualjournals only, computed from the returned JournalLines, because a
 * manual journal's key is Narration + Date + Total and the Total half can only be evaluated here
 * (Xero has no filterable Total field). It is null for every other collection and for a journal
 * whose lines Xero did not return.
 */
export function readExisting(
  collection: string,
  responseBody: unknown,
): Array<{ id: string; status: string; total: number | null }> {
  if (!responseBody || typeof responseBody !== 'object') return [];
  const idField: Record<string, string> = {
    invoices: 'InvoiceID',
    banktransactions: 'BankTransactionID',
    creditnotes: 'CreditNoteID',
    manualjournals: 'ManualJournalID',
  };
  const wanted = idField[collection];
  for (const value of Object.values(responseBody as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    return value
      .filter((v) => v && typeof v === 'object')
      .map((v) => {
        const row = v as Record<string, unknown>;
        return {
          id: String(row[wanted] ?? row['ID'] ?? ''),
          status: String(row['Status'] ?? ''),
          total: collection === 'manualjournals' ? manualJournalTotal(row) : null,
        };
      })
      .filter((r) => r.id);
  }
  return [];
}

/**
 * Whether an existing object should block a re-create. A VOIDED or DELETED object still counts:
 * the census duplicates were overwhelmingly VOIDED, and re-creating against them is precisely how
 * a bill reached four objects. Blocking on them is the point, not an oversight.
 */
export function blocksCreate(statuses: string[]): boolean {
  return statuses.length > 0;
}

/**
 * True when `path` targets the Xero Attachments sub-resource of some record -- e.g.
 * "/Invoices/{guid}/Attachments/{fileName}" or ".../Attachments" (a listing shape, GET-only in
 * practice but matched here too for robustness). Detected by SEGMENT, not by a fixed position or a
 * hardcoded endpoint allowlist (compare ATTACHMENT_ENDPOINT_ENUM in tools.ts, which enumerates the
 * record types Xero currently lets carry attachments): the danger this guards against is the PATH
 * SHAPE, not which specific endpoint it hangs off, so this keeps working even if Xero adds another
 * attachment-capable endpoint or a caller mistypes one. Case-insensitive on purpose -- a caller's
 * casing slip must never fall through to a live write instead of a loud refusal.
 */
export function isAttachmentPath(path: string): boolean {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .some((segment) => segment.toLowerCase() === 'attachments');
}

/**
 * Guard for `xero_request` closing the RESIDUAL half of FND-20260724-f6df (found 2026-08-28).
 *
 * The original finding fixed the dedicated `xero_attachment_upload` tool (xeroUploadAttachment in
 * client.ts sends the correct raw-file-bytes-plus-real-Content-Type request Xero's Attachments API
 * requires), but left the UNIVERSAL `xero_request` tool able to reach the exact same Attachments
 * sub-resource unguarded. `xeroRequest()` (client.ts) always `JSON.stringify()`s its body and always
 * sends `Content-Type: application/json` -- there was nothing stopping a caller from POSTing or
 * PUTting straight to "/ManualJournals/{guid}/Attachments/{fileName}" through xero_request with a
 * JSON body, silently reproducing the identical defect the dedicated tool was built to fix: Xero
 * accepts the JSON text as though it were the file and returns a plausible 200 plus a real-shaped
 * AttachmentID, while nothing usable is ever persisted (independently verified via xero_attachments
 * returning `Attachments:[]` after every such attempt, at every payload size tried -- the original
 * finding's evidence). The tool's own description already told callers not to do this; a prose
 * warning is not an enforcement, and this is the enforcement.
 *
 * A DELETE is not gated: it carries no body, so it cannot trigger the JSON-body-instead-of-bytes
 * mismatch this guard exists to prevent.
 *
 * Returns the exact `{error, summary}` pair the handler returns to the caller WITHOUT ever calling
 * xeroRequest (and therefore without any network call), or null when the write may proceed. Pure
 * function, extracted for the same reason as checkAttachmentPayloadIntegrity in tools.ts: directly
 * unit-testable without Cosmos, ring gating, or a live Xero token.
 */
export function attachmentWriteRefusal(method: string, path: string): { error: string; summary: string } | null {
  if (method.toUpperCase() === 'DELETE') return null;
  if (!isAttachmentPath(path)) return null;
  return {
    error: 'use_xero_attachment_upload',
    summary:
      `REFUSED (nothing sent to Xero): "${path}" targets the Attachments sub-resource. xero_request always sends a ` +
      `JSON body with Content-Type: application/json, but Xero's Attachments API requires the RAW FILE BYTES with ` +
      `the file's own Content-Type -- this is the exact mismatch behind FND-20260724-f6df (a plausible 200 + ` +
      `AttachmentID returned while nothing is actually persisted). Use xero_attachment_upload instead, then verify ` +
      `with xero_attachments.`,
  };
}
