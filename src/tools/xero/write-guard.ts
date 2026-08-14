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
export function unwrapItems(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>;
  }
  // A bare single object (Xero accepts this on some endpoints).
  return Object.keys(obj).length ? [obj] : [];
}

/** The natural key a duplicate would share. The census duplicates all carried the importer's
 *  `Reference` (QBO-Bill-NNNNN / QBO-Transfer-id), which is exactly what a dedupe should key on. */
export function naturalKeyOf(item: Record<string, unknown>): { field: string; value: string } | null {
  for (const field of ['Reference', 'InvoiceNumber', 'CreditNoteNumber']) {
    const v = item[field];
    if (typeof v === 'string' && v.trim()) return { field, value: v.trim() };
  }
  return null;
}

export interface MappingViolation {
  itemIndex: number;
  lineIndex: number;
  accountCode: string;
}

/**
 * Cross-org mapping defence: a write whose line items identify the account by CODE cannot be
 * verified as landing in the intended account, because codes are per-org and Xero re-resolves them
 * locally. Require `AccountID` (a GUID, globally unique) instead. Returns every violation rather
 * than the first, so one refusal shows the caller the whole set to fix.
 */
export function findAccountCodeViolations(body: unknown): MappingViolation[] {
  const out: MappingViolation[] = [];
  unwrapItems(body).forEach((item, itemIndex) => {
    const lines = item['LineItems'];
    if (!Array.isArray(lines)) return;
    lines.forEach((line, lineIndex) => {
      if (!line || typeof line !== 'object') return;
      const l = line as Record<string, unknown>;
      const code = l['AccountCode'];
      const id = l['AccountID'] ?? l['AccountId'];
      if (code !== undefined && code !== null && String(code).trim() !== '' && !id) {
        out.push({ itemIndex, lineIndex, accountCode: String(code) });
      }
    });
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
export function existsFilterFor(key: { field: string; value: string }): string {
  const escaped = key.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${key.field}=="${escaped}"`;
}

export interface ExistingHit {
  reference: string;
  ids: string[];
  statuses: string[];
}

/** Pull (id, status) pairs out of a Xero list response for whichever collection was probed. */
export function readExisting(collection: string, responseBody: unknown): Array<{ id: string; status: string }> {
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
