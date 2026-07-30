/**
 * xero_gl_assemble — server-side general-ledger reconstruction (CFO P0-2, 2026-07-30).
 *
 * WHY THIS EXISTS: the CFO close needs ledger-level truth without either (a) the gated Journals
 * endpoint (declined — $1,445 AUD/mo behind a security assessment, see xero_connections /
 * XERO_JOURNALS_GRANDFATHER_CUTOFF) or (b) a human clicking through a UI export every time
 * anything changes (rejected by the operator as a recurring dependency). The insight: Xero's own
 * TrialBalance report already computes account balances correctly at any as-at date and cannot
 * miss anything (it is the vendor's own ledger truth, not a reconstruction) — diffing consecutive
 * month-end TrialBalances gives the per-account PERIOD MOVEMENT directly, using only scopes
 * already granted. This module fetches those snapshots + the underlying source documents and
 * assembles them server-side so a caller never has to page through ~295KB TrialBalance reads
 * (~10 JIT pages EACH) client-side, twelve times a year, forever.
 *
 * HONEST V1 SCOPE (read before trusting `variance` for anything audit-facing):
 *   - `tbMovement` is Xero's own computed balance, diffed. Always correct; this is ground truth.
 *   - `manualJournalNet` sums ManualJournal.JournalLines[].LineAmount (signed: Xero's documented
 *     convention is positive = debit, negative = credit) by AccountID, per month. `variance` =
 *     tbMovement - manualJournalNet, i.e. THIS TOOL ONLY NETS MANUAL JOURNALS AGAINST THE TRIAL
 *     BALANCE. A near-zero variance on an account whose ONLY movement was manual journals is a
 *     real completeness proof for that account in that month.
 *   - Invoices / CreditNotes / BankTransactions line items ARE fetched and summed by account (see
 *     `otherDocuments`), but as GROSS, UNSIGNED activity — NOT netted into `variance`. Getting the
 *     debit/credit sign right for these depends on invoice Type (ACCREC/ACCPAY), transaction Type
 *     (RECEIVE/SPEND), and the account's normal balance side, and Xero's own posting engine ALSO
 *     writes the other side of each of these transactions (AR/AP/bank control accounts) that never
 *     appears in any LineItems array at all — so a variance computed against these sources would
 *     look precise while silently being wrong. Shipping an incorrect-but-confident variance number
 *     on public-company financials is a worse outcome than shipping a clearly-labeled partial one.
 *     A nonzero variance on an account that ALSO has invoice/credit-note/bank-transaction activity
 *     this month is EXPECTED, not a defect — cross-check it against `otherDocuments` directly.
 *   - Payments, BankTransfers, ExpenseClaims, Receipts are NOT pulled by this v1: Payments and
 *     BankTransfers don't carry a per-account LineItems breakdown the way Invoices/CreditNotes/
 *     BankTransactions do (they reference invoices/bank accounts, not a line-item account split);
 *     ExpenseClaims/Receipts are blocked by the P0-3 401s. Add them once P0-3 resolves and once a
 *     signed netting model for AR/AP/bank control accounts is designed and live-verified.
 *
 * NEEDS A LIVE SMOKE TEST BEFORE FIRST REAL USE: the TrialBalance row parser below assumes Xero's
 * report Cells[0].Attributes carries an entry with Id:"account" whose Value is the AccountID GUID
 * (matching ManualJournal.JournalLines[].AccountID) — this shape is documented but has NOT been
 * live-verified against a real org from this session (Xero tools are EXEC_RING-gated; the CTO seat
 * that wrote this is deliberately excluded from that ring). Run the acceptance test below on one
 * real org/year before treating any variance number as authoritative. If accounts show as
 * "unmatched" on both TB and journal sides, that mismatch is the symptom to look for first.
 *
 * ACCEPTANCE TEST (per the CFO spec): call for one org over one full year. Confirm it returns
 * per-account TB movement, summed manual-journal detail, and variance, in one call, without the
 * caller paging anything (JIT offload handles size automatically — see result-store.ts). Re-run it
 * and confirm the numbers are identical (deterministic).
 */
import { type XeroOrg, type TokenDeps, xeroGet } from './client.js';

// ---------------------------------------------------------------------------------------------
// Pure date math
// ---------------------------------------------------------------------------------------------

/** Last day of (year, month0) as YYYY-MM-DD, UTC. Pure. */
export function monthEndIso(year: number, month0: number): string {
  return new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);
}

/**
 * Month-end dates covering the full months containing `from` through `to`, PLUS one extra
 * preceding month-end (the baseline snapshot every diff needs). `from`/`to` are YYYY-MM-DD; the
 * DAY within each is ignored — the range is always widened to whole calendar months, since a
 * period movement is only meaningful between two month-end snapshots. Pure.
 */
export function monthEndDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('monthEndDates: from/to must be parseable dates (YYYY-MM-DD)');
  }
  if (end.getTime() < start.getTime()) throw new Error('monthEndDates: to must not be before from');
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  let by = y;
  let bm = m - 1;
  if (bm < 0) {
    bm = 11;
    by -= 1;
  }
  const dates = [monthEndIso(by, bm)];
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  // Bounded: a caller requesting an implausibly large range gets a clear error rather than an
  // unbounded loop / thousands of Xero calls.
  let guard = 0;
  while (y < endY || (y === endY && m <= endM)) {
    if (++guard > 120) throw new Error('monthEndDates: range exceeds 120 months; narrow from/to');
    dates.push(monthEndIso(y, m));
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return dates;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// TrialBalance parsing
// ---------------------------------------------------------------------------------------------

export interface TbRow {
  accountId: string;
  name: string;
  debit: number;
  credit: number;
}

interface XeroCell {
  Value?: string;
  Attributes?: Array<{ Id?: string; Value?: string }>;
}
interface XeroRow {
  RowType?: string;
  Cells?: XeroCell[];
  Rows?: XeroRow[];
}
interface XeroReportBody {
  Reports?: Array<{ Rows?: XeroRow[] }>;
}

function numVal(cell: XeroCell | undefined): number {
  if (!cell?.Value) return 0;
  const n = Number.parseFloat(cell.Value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Flattens a Xero TrialBalance report body into one row per account. Skips Header/SummaryRow rows
 * (Xero marks totals distinctly); descends into Section rows (the report groups accounts by
 * class). Defensive: an unrecognized/empty shape returns []  rather than throwing, so one month's
 * parse failure never takes down the whole assembly (the caller flags a zero-row month in
 * caveats). Pure.
 */
export function parseTrialBalanceRows(body: unknown): TbRow[] {
  const report = (body as XeroReportBody)?.Reports?.[0];
  const rows: TbRow[] = [];
  if (!report?.Rows) return rows;
  const walk = (rs: XeroRow[]) => {
    for (const r of rs) {
      if (r.RowType === 'Section' && Array.isArray(r.Rows)) {
        walk(r.Rows);
        continue;
      }
      if (r.RowType !== 'Row' || !Array.isArray(r.Cells) || r.Cells.length === 0) continue;
      const first = r.Cells[0];
      const name = first.Value || '';
      if (!name) continue;
      const accountAttr = first.Attributes?.find((a) => a.Id === 'account');
      const accountId = accountAttr?.Value || `name:${name}`;
      const debit = numVal(r.Cells[1]);
      const credit = numVal(r.Cells[2]);
      rows.push({ accountId, name, debit, credit });
    }
  };
  walk(report.Rows);
  return rows;
}

export interface AccountMovement {
  accountId: string;
  name: string;
  tbMovement: number;
}

/** Diffs two TrialBalance snapshots into per-account net movement (debit - credit, current minus
 * prior). An account present in only one snapshot is treated as 0 on the side it's absent from
 * (newly opened / fully zeroed-out account). Pure. */
export function diffTrialBalances(prev: TbRow[], curr: TbRow[]): AccountMovement[] {
  const prevMap = new Map(prev.map((r) => [r.accountId, r]));
  const currMap = new Map(curr.map((r) => [r.accountId, r]));
  const ids = new Set<string>([...prevMap.keys(), ...currMap.keys()]);
  const out: AccountMovement[] = [];
  for (const id of ids) {
    const p = prevMap.get(id);
    const c = currMap.get(id);
    const pNet = p ? p.debit - p.credit : 0;
    const cNet = c ? c.debit - c.credit : 0;
    out.push({ accountId: id, name: (c ?? p)?.name || '', tbMovement: round2(cNet - pNet) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ManualJournal signed net-by-account (feeds `variance`)
// ---------------------------------------------------------------------------------------------

interface MjLine {
  AccountID?: string;
  AccountCode?: string;
  LineAmount?: number;
}
interface ManualJournal {
  ManualJournalID?: string;
  Date?: string;
  JournalLines?: MjLine[];
}
interface ManualJournalsBody {
  ManualJournals?: ManualJournal[];
}

/** Sums ManualJournal.JournalLines[].LineAmount by AccountID (Xero's documented sign convention:
 * positive = debit, negative = credit — the same sign sense as TrialBalance's debit-minus-credit
 * net used in diffTrialBalances, so the two are directly comparable). Pure. */
export function sumManualJournalsByAccount(body: unknown): Map<string, number> {
  const mjs = (body as ManualJournalsBody)?.ManualJournals ?? [];
  const out = new Map<string, number>();
  for (const mj of mjs) {
    for (const line of mj.JournalLines ?? []) {
      const key = line.AccountID || (line.AccountCode ? `code:${line.AccountCode}` : '');
      if (!key) continue;
      const amt = typeof line.LineAmount === 'number' ? line.LineAmount : 0;
      out.set(key, round2((out.get(key) ?? 0) + amt));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gross line-item activity by account, for Invoices / CreditNotes / BankTransactions (informational
// only — NOT netted into variance; see the module doc comment).
// ---------------------------------------------------------------------------------------------

interface LineItem {
  AccountID?: string;
  AccountCode?: string;
  LineAmount?: number;
}
interface DocWithLines {
  LineItems?: LineItem[];
}

export function sumLineItemsByAccount(docs: DocWithLines[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of docs) {
    for (const li of d.LineItems ?? []) {
      const key = li.AccountID || (li.AccountCode ? `code:${li.AccountCode}` : '');
      if (!key) continue;
      const amt = typeof li.LineAmount === 'number' ? li.LineAmount : 0;
      out.set(key, round2((out.get(key) ?? 0) + Math.abs(amt)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bounded pager for the source-document fetches (Invoices/CreditNotes/BankTransactions/
// ManualJournals) over a date range, in ONE fetch-and-bucket pass rather than once per month.
// ---------------------------------------------------------------------------------------------

const MAX_PAGES_PER_ENDPOINT = 20; // 100/page -> 2000 records/endpoint/call; bounded, flagged if hit.

async function fetchAllPaged(
  org: XeroOrg,
  path: string,
  arrayKey: string,
  where: string,
  deps?: TokenDeps,
): Promise<{ items: Record<string, unknown>[]; truncated: boolean }> {
  const items: Record<string, unknown>[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES_PER_ENDPOINT; page++) {
    const res = await xeroGet(org, path, { page: String(page), where }, { deps });
    const arr = (res.body as Record<string, unknown>)?.[arrayKey];
    if (!Array.isArray(arr) || arr.length === 0) break;
    items.push(...(arr as Record<string, unknown>[]));
    if (arr.length < 100) break; // short page = last page
    if (page === MAX_PAGES_PER_ENDPOINT) truncated = true;
  }
  return { items, truncated };
}

function dateWhere(from: string, to: string): string {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return `Date >= DateTime(${fy},${fm},${fd}) && Date <= DateTime(${ty},${tm},${td})`;
}

function monthKeyOf(dateStr: string | undefined): string {
  if (!dateStr) return '';
  // Xero dates on list endpoints are usually /Date(epoch+tz)/ or ISO; handle both defensively.
  const m = /\/Date\((\d+)/.exec(dateStr);
  const d = m ? new Date(Number(m[1])) : new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First day of the month a YYYY-MM-DD month-end date falls in, as YYYY-MM-DD. Pure. */
export function firstDayOfMonth(monthEndDate: string): string {
  const [y, m] = monthEndDate.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------------

export interface GlAssembleAccountRow {
  accountId: string;
  name: string;
  tbMovement: number;
  manualJournalNet: number;
  variance: number;
}

export interface GlAssembleMonth {
  periodStart: string;
  periodEnd: string;
  accounts: GlAssembleAccountRow[];
  nonzeroVarianceCount: number;
  /** THIS month's Invoices/CreditNotes/BankTransactions activity only — bucketed per month (not a
   * whole-range aggregate) precisely so "does this account also show otherDocuments activity in
   * THIS SAME month" (the check methodology_note tells callers to make) is actually answerable. */
  otherDocuments: {
    invoicesLineGrossByAccount: Record<string, number>;
    creditNotesLineGrossByAccount: Record<string, number>;
    bankTransactionsLineGrossByAccount: Record<string, number>;
  };
}

export interface GlAssembleResult {
  org: XeroOrg;
  from: string;
  to: string;
  months: GlAssembleMonth[];
  caveats: string[];
  methodology_note: string;
}

const METHODOLOGY_NOTE =
  'variance = tbMovement - manualJournalNet. tbMovement is Xero\'s own TrialBalance, diffed month-over-month (always correct). ' +
  'manualJournalNet nets ONLY ManualJournals against it — a near-zero variance is a real completeness proof for accounts whose only ' +
  'activity was manual journals. Invoices/CreditNotes/BankTransactions line-item activity is returned separately in each month\'s ' +
  '`otherDocuments` (gross, unsigned, by account, THIS MONTH ONLY) and is NOT netted into variance — a nonzero variance on an account ' +
  'that also appears in that SAME month\'s otherDocuments is EXPECTED, not a defect. See this file\'s module doc comment for why. ' +
  'A month is OMITTED from `months` (with a caveat explaining why) rather than computed from an unparseable TrialBalance snapshot — ' +
  'diffing a real snapshot against a failed-to-parse one would fabricate a full balance reversal/reinstatement, which is worse than a gap.';

/**
 * Assembles the general ledger for one org over [from, to]: per-account TrialBalance movement,
 * netted against ManualJournals, plus supporting Invoices/CreditNotes/BankTransactions detail,
 * bucketed per month. One call replaces what would otherwise be ~12+ separate TrialBalance reads a
 * year, done client-side, every time (see module doc comment). Read-only; makes no writes.
 */
export async function assembleGl(org: XeroOrg, from: string, to: string, deps?: TokenDeps): Promise<GlAssembleResult> {
  const caveats: string[] = [];
  const dates = monthEndDates(from, to);
  // The TrialBalance snapshots are always widened to whole calendar months (dates[0] = the
  // baseline month-end BEFORE `from`'s month; dates[last] = the month-end of `to`'s month). Every
  // OTHER source fetch below (ManualJournals/Invoices/CreditNotes/BankTransactions) MUST use these
  // SAME widened bounds, not the caller's original from/to — otherwise a partial-month request
  // (e.g. from=2026-03-05) diffs a full-month TB movement against a document window that only
  // covers March 5-20, producing a false variance for no reason other than the mismatch itself.
  const effectiveFrom = firstDayOfMonth(dates[1]);
  const effectiveTo = dates[dates.length - 1];
  const effectiveWhere = dateWhere(effectiveFrom, effectiveTo);

  // 1. TrialBalance at every month-end. A snapshot that parses to 0 rows is flagged INVALID (most
  // likely a parse failure, not a genuinely brand-new org with a truly empty trial balance — and
  // treating the ambiguous case as invalid is the fail-closed choice) so step 4 never diffs a real
  // snapshot against it.
  const snapshots: TbRow[][] = [];
  const invalidSnapshot: boolean[] = [];
  for (const date of dates) {
    const res = await xeroGet(org, '/Reports/TrialBalance', { date }, { deps });
    const rows = parseTrialBalanceRows(res.body);
    const invalid = rows.length === 0;
    if (invalid) caveats.push(`TrialBalance at ${date} parsed to 0 rows — treated as an invalid/unparseable snapshot, not a real balance. Every period touching this date is OMITTED from months (rather than diffed, which would fabricate a full balance swing).`);
    invalidSnapshot.push(invalid);
    snapshots.push(rows);
  }

  // 2. ManualJournals across the EFFECTIVE (widened) range, bucketed by month.
  const mjRes = await fetchAllPaged(org, '/ManualJournals', 'ManualJournals', effectiveWhere, deps);
  if (mjRes.truncated) caveats.push(`ManualJournals hit the ${MAX_PAGES_PER_ENDPOINT}-page cap (${MAX_PAGES_PER_ENDPOINT * 100}+ records) — some journals in range may be missing from manualJournalNet.`);
  const mjByMonth = new Map<string, ManualJournal[]>();
  for (const raw of mjRes.items) {
    const mj = raw as ManualJournal;
    const key = monthKeyOf(mj.Date);
    if (!key) continue;
    if (!mjByMonth.has(key)) mjByMonth.set(key, []);
    mjByMonth.get(key)!.push(mj);
  }

  // 3. Invoices / CreditNotes / BankTransactions across the EFFECTIVE range, bucketed by month —
  // gross, informational, per-month (see GlAssembleMonth doc comment for why per-month matters).
  // SEQUENTIAL, not Promise.all: xeroGet's per-org rate spacing (client.ts) is a read-then-sleep-
  // then-write on a shared lastCallAt map with no lock — concurrent calls can race past each other
  // and burst Xero's rate limit instead of respecting the intended spacing. This tool already makes
  // many calls per invocation; it should not also be the thing that trips a 429.
  const invRes = await fetchAllPaged(org, '/Invoices', 'Invoices', effectiveWhere, deps);
  if (invRes.truncated) caveats.push(`Invoices hit the ${MAX_PAGES_PER_ENDPOINT}-page cap — invoicesLineGrossByAccount is incomplete for one or more months.`);
  const cnRes = await fetchAllPaged(org, '/CreditNotes', 'CreditNotes', effectiveWhere, deps);
  if (cnRes.truncated) caveats.push(`CreditNotes hit the ${MAX_PAGES_PER_ENDPOINT}-page cap — creditNotesLineGrossByAccount is incomplete for one or more months.`);
  const btRes = await fetchAllPaged(org, '/BankTransactions', 'BankTransactions', effectiveWhere, deps);
  if (btRes.truncated) caveats.push(`BankTransactions hit the ${MAX_PAGES_PER_ENDPOINT}-page cap — bankTransactionsLineGrossByAccount is incomplete for one or more months.`);

  const byMonth = <T extends { Date?: string }>(items: T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const item of items) {
      const key = monthKeyOf(item.Date);
      if (!key) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(item);
    }
    return out;
  };
  const invByMonth = byMonth(invRes.items as Array<DocWithLines & { Date?: string }>);
  const cnByMonth = byMonth(cnRes.items as Array<DocWithLines & { Date?: string }>);
  const btByMonth = byMonth(btRes.items as Array<DocWithLines & { Date?: string }>);
  const toRecord = (m: Map<string, number>): Record<string, number> => Object.fromEntries(m);

  // 4. Per-month: diff TB, net ManualJournals, compute variance. Skip (omit, with a caveat already
  // logged in step 1) any period whose start OR end snapshot was invalid.
  const months: GlAssembleMonth[] = [];
  for (let i = 1; i < dates.length; i++) {
    if (invalidSnapshot[i - 1] || invalidSnapshot[i]) continue;
    const periodStart = dates[i - 1];
    const periodEnd = dates[i];
    const movements = diffTrialBalances(snapshots[i - 1], snapshots[i]);
    // Month bucket key = the calendar month periodEnd falls in.
    const [ey, em] = periodEnd.split('-').map(Number);
    const monthKey = `${ey}-${String(em).padStart(2, '0')}`;
    const mjBody = { ManualJournals: mjByMonth.get(monthKey) ?? [] };
    const mjNet = sumManualJournalsByAccount(mjBody);
    let nonzeroVarianceCount = 0;
    const accounts: GlAssembleAccountRow[] = movements.map((m) => {
      const manualJournalNet = mjNet.get(m.accountId) ?? 0;
      const variance = round2(m.tbMovement - manualJournalNet);
      if (variance !== 0) nonzeroVarianceCount++;
      return { accountId: m.accountId, name: m.name, tbMovement: m.tbMovement, manualJournalNet, variance };
    });
    months.push({
      periodStart,
      periodEnd,
      accounts,
      nonzeroVarianceCount,
      otherDocuments: {
        invoicesLineGrossByAccount: toRecord(sumLineItemsByAccount(invByMonth.get(monthKey) ?? [])),
        creditNotesLineGrossByAccount: toRecord(sumLineItemsByAccount(cnByMonth.get(monthKey) ?? [])),
        bankTransactionsLineGrossByAccount: toRecord(sumLineItemsByAccount(btByMonth.get(monthKey) ?? [])),
      },
    });
  }
  if (months.length === 0 && dates.length > 1) {
    caveats.push('Every requested period touched an invalid TrialBalance snapshot — months is empty. See the per-date caveats above.');
  }

  return { org, from, to, months, caveats, methodology_note: METHODOLOGY_NOTE };
}
