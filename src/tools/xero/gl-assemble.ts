/**
 * xero_gl_assemble — server-side general-ledger reconstruction (CFO P0-2, 2026-07-30).
 *
 * WHY THIS EXISTS: the CFO close needs ledger-level truth without either (a) the gated Journals
 * endpoint (declined — $1,445 AUD/mo behind a security assessment, see xero_connections /
 * XERO_JOURNALS_GRANDFATHER_CUTOFF) or (b) a human clicking through a UI export every time
 * anything changes (rejected by the operator as a recurring dependency). The insight: Xero's own
 * TrialBalance report already computes each month's account movement correctly and cannot miss
 * anything (it is the vendor's own ledger truth, not a reconstruction) — reading that movement
 * directly at each month-end, using only scopes already granted, gives per-account PERIOD
 * MOVEMENT with no client-side arithmetic on top of it. This module fetches those figures + the
 * underlying source documents and assembles them server-side so a caller never has to page
 * through ~295KB TrialBalance reads (~10 JIT pages EACH) client-side, twelve times a year, forever.
 *
 * CORRECTED 2026-07-30 (CFO live acceptance test, real production data): the FIRST version of this
 * tool fetched TrialBalance at consecutive month-ends and DIFFED them, on the assumption that
 * Cells[1]/Cells[2] ("Debit"/"Credit") were a CUMULATIVE balance as-at that date. They are not.
 * Xero's TrialBalance report row is 5 cells wide — [0] Account, [1] Debit (THIS MONTH's movement),
 * [2] Credit (THIS MONTH's movement), [3] YTD Debit, [4] YTD Credit — and the period pair at a
 * single `date` query is ALREADY that month's net movement, not a running balance. Diffing two
 * already-period figures computed `period(N) - period(N-1)`, a second derivative, not a movement:
 * accidentally correct in the first month of a range (when period(N-1) is the implicit 0 of an
 * unset baseline) and arithmetically wrong — an exact sign-flipped negation — in every month after
 * it. Proof: a real December figure of -12,640,455.18 against a real November of +12,640,455.18
 * on an account with NO December activity is exactly 0 - period(Nov). THE FIX: read the period pair
 * directly, once per month, and never diff two TrialBalance snapshots against each other again.
 * This is also cheaper (one TrialBalance call per requested month instead of N+1).
 *
 * HONEST V1 SCOPE (read before trusting `variance` for anything audit-facing):
 *   - `tbMovement` is Xero's own reported period movement for that month, read directly (not
 *     diffed). Ground truth, assuming the row resolves to an account at all — see the next bullet.
 *   - A TrialBalance row with NEITHER a resolvable account GUID NOR a display name cannot be
 *     attributed to any account and is DROPPED — but never silently: parseTrialBalanceRows reports
 *     an `unresolvedRowCount`, and assembleGl turns any nonzero count into a loud caveat naming the
 *     affected date, rather than a clean-looking output with a hole in it (the worse failure mode
 *     on a public company's ledger, per the CFO's own review of this exact risk).
 *   - `manualJournalNet` sums ManualJournal.JournalLines[].LineAmount (signed: Xero's documented
 *     convention is positive = debit, negative = credit) by AccountID, per month. `variance` =
 *     tbMovement - manualJournalNet, i.e. THIS TOOL ONLY NETS MANUAL JOURNALS AGAINST THE TRIAL
 *     BALANCE. A near-zero variance on an account whose ONLY movement was manual journals is a
 *     real completeness proof for that account in that month.
 *   - A cheap SELF-CHECK runs on every month after the first requested one, using YTD columns
 *     already present in the SAME fetched rows (no extra API calls): period(month) should equal
 *     YTD(month) - YTD(prior month) for a given account. A mismatch beyond a cent is surfaced as a
 *     caveat (it may simply mean a financial-year boundary fell between the two months, where YTD
 *     legitimately resets — that is a plausible, named explanation, not silently swallowed).
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
 *     ExpenseClaims/Receipts are blocked by the P0-3 401s (vendor returns a bare, undiscriminating
 *     401 on both — confirmed by the CFO against live data; not fixable from this side). Add them
 *     once P0-3 resolves and once a signed netting model for AR/AP/bank control accounts is
 *     designed and live-verified.
 *
 * LIVE-VERIFIED 2026-07-30 (CFO acceptance test, real production data): the AccountID-GUID join
 * between TrialBalance's Cells[0].Attributes (Id:"account") and ManualJournal.JournalLines[].
 * AccountID is CONFIRMED correct (same identifier space, no transformation, verified across ~20
 * rows). The tool is deterministic (two runs, byte-identical output). The mechanism is proven
 * correct in isolation (a virgin account created same-day nets to the posted figure exactly, to
 * the cent, variance 0.00). One OPEN issue remains from that same test, not yet root-caused: a
 * single known real account (a manual-journal debit of 7,365,719.00, independently confirmed on
 * the live ledger) reported as tbMovement:0, manualJournalNet:0 on BOTH sides simultaneously —
 * ruled out as the differencing bug (which produces equal-and-opposite figures, not zeros) and
 * ruled out as a documents-not-netted issue (this is the TB/journal join itself). The parser
 * hardening in this file (recursing into any row with nested Rows, not only ones typed "Section";
 * treating a fully unresolvable row as a loud caveat instead of a silent drop) closes the two most
 * plausible mechanisms without yet confirming which one it was — the CFO is pulling the raw row
 * shapes for that specific account to pin down the exact cause.
 *
 * ACCEPTANCE TEST (per the CFO spec): call for one org over one full year. Confirm it returns
 * per-account TB movement, summed manual-journal detail, and variance, in one call, without the
 * caller paging anything (JIT offload handles size automatically — see result-store.ts). Re-run it
 * and confirm the numbers are identical (deterministic). Confirm a two-consecutive-month range
 * shows the CORRECT (non-negated) figure for a month with no real activity — the regression test
 * for the differencing bug this file no longer has.
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
 * preceding month-end at index 0. `from`/`to` are YYYY-MM-DD; the DAY within each is ignored — the
 * range is always widened to whole calendar months. NOTE: assembleGl no longer diffs consecutive
 * entries against each other (see this file's CORRECTED note above) — it reads each requested
 * month's TrialBalance movement directly and uses dates[0] only to derive the widened `from` bound
 * for the document fetches (ManualJournals/Invoices/CreditNotes/BankTransactions), via
 * firstDayOfMonth(dates[1]). The leading entry is kept in this function's contract because it is
 * independently tested and other callers may still want a "one month back" boundary. Pure.
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

/** One account's figures from a SINGLE TrialBalance snapshot at one `date`. `debit`/`credit` are
 * THAT MONTH's movement (Xero's period pair, Cells[1]/[2]) — NOT a cumulative balance; never diff
 * these across two dates (see this file's CORRECTED note). `ytdDebit`/`ytdCredit` (Cells[3]/[4])
 * ARE cumulative since the financial year start; used only for the same-snapshot-set self-check. */
export interface TbRow {
  accountId: string;
  name: string;
  debit: number;
  credit: number;
  ytdDebit: number;
  ytdCredit: number;
}

export interface ParsedTrialBalance {
  rows: TbRow[];
  /** Rows that had Cells but resolved to NEITHER an account GUID NOR a non-empty display name —
   * dropped because there is nothing to key them by, but counted so the caller can surface a loud
   * caveat instead of a silently incomplete result. */
  unresolvedRowCount: number;
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
 * Flattens a Xero TrialBalance report body into one row per account, for a SINGLE snapshot date.
 * Descends into ANY row that carries nested `Rows`, regardless of that row's own RowType (not
 * gated on RowType === 'Section' — a real report may nest a sub-total-with-detail under a row
 * typed something other than "Section"; the prior version's Section-only gate is one of the two
 * plausible mechanisms behind a CFO-observed account going fully invisible on both the TB and
 * journal sides at once, see this file's LIVE-VERIFIED note). A row that carries nested `Rows` is
 * treated as a CONTAINER ONLY and never also parsed as a leaf account itself, even if it also
 * carries its own `Cells` (Copilot-caught, 2026-07-30, round 3: a subtotal-with-detail row can have
 * both a label+amount pair AND child Rows — parsing the parent too would emit a synthetic
 * `name:<subtotal>` account alongside its own children, or silently overwrite a child that happens
 * to share the same account GUID, corrupting the financial output). A leaf 'Row' that cannot be
 * attributed to any account (no account-GUID Attribute AND no non-empty display name) is dropped
 * but COUNTED via `unresolvedRowCount` rather than silently disappearing. Defensive: an
 * unrecognized/empty body shape returns `{rows: [], unresolvedRowCount: 0}` rather than throwing,
 * so one month's parse failure never takes down the whole assembly (the caller flags a zero-row
 * month in caveats). Pure.
 */
export function parseTrialBalanceRows(body: unknown): ParsedTrialBalance {
  const report = (body as XeroReportBody)?.Reports?.[0];
  const rows: TbRow[] = [];
  let unresolvedRowCount = 0;
  if (!report?.Rows) return { rows, unresolvedRowCount };
  const walk = (rs: XeroRow[]) => {
    for (const r of rs) {
      if (Array.isArray(r.Rows) && r.Rows.length > 0) {
        walk(r.Rows);
        continue; // container: children are already processed, never ALSO parse the parent as a leaf account
      }
      if (r.RowType !== 'Row' || !Array.isArray(r.Cells) || r.Cells.length === 0) continue;
      const first = r.Cells[0];
      const name = first.Value || '';
      const accountAttr = first.Attributes?.find((a) => a.Id === 'account');
      const accountId = accountAttr?.Value || (name ? `name:${name}` : '');
      if (!accountId) {
        unresolvedRowCount++;
        continue;
      }
      rows.push({
        accountId,
        name: name || '(unnamed)',
        debit: numVal(r.Cells[1]),
        credit: numVal(r.Cells[2]),
        ytdDebit: numVal(r.Cells[3]),
        ytdCredit: numVal(r.Cells[4]),
      });
    }
  };
  walk(report.Rows);
  return { rows, unresolvedRowCount };
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
  Status?: string;
  JournalLines?: MjLine[];
}
interface ManualJournalsBody {
  ManualJournals?: ManualJournal[];
}

/** Sums ManualJournal.JournalLines[].LineAmount by AccountID (Xero's documented sign convention:
 * positive = debit, negative = credit — the same sign sense as TrialBalance's debit-minus-credit
 * net). ONLY POSTED journals are summed: DRAFT and VOIDED journals never hit the Trial Balance, so
 * including them would make `variance` disagree with the real TB for reasons that have nothing to
 * do with a genuine gap (reviewer-caught, 2026-07-30). A journal with no Status field at all
 * (should not happen on a real Xero response, but defensive against a stub/fixture) is treated as
 * POSTED rather than silently dropped, so this can never fail closed on a field this function does
 * not strictly require. Pure. */
export function sumManualJournalsByAccount(body: unknown): Map<string, number> {
  const mjs = (body as ManualJournalsBody)?.ManualJournals ?? [];
  const out = new Map<string, number>();
  for (const mj of mjs) {
    if (mj.Status && mj.Status !== 'POSTED') continue;
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

export const MAX_PAGES_PER_ENDPOINT = 20; // 100/page -> 2000 records/endpoint/call; bounded, flagged if hit.

/**
 * Wall-clock budget (FND-20260829-e454): xeroGet's own rate-limit spacing (MIN_SPACING_MS = 1100ms
 * in client.ts) means EVERY Xero call costs at least ~1.1s regardless of latency, and assembleGl
 * makes one such call per requested month PLUS up to MAX_PAGES_PER_ENDPOINT (20) sequential calls
 * for EACH of 4 endpoints -- up to ~200 sequential, individually-rate-limited calls in the
 * documented worst case ("call for one org over one full year" is this tool's OWN acceptance
 * test), which can exceed even a 60s budget, let alone ChatGPT's 45-second-per-call hard timeout.
 * `deadline`/`now` are threaded through both the per-month TrialBalance loop and fetchAllPaged
 * (below) from ONE shared clock, so the two phases share a single wall-clock ceiling rather than
 * each independently risking the full budget. Optional, defaulting to "no bound" (Infinity) so
 * every existing direct caller/test of fetchAllPaged/assembleGl is completely unaffected. */
export interface GlBudget {
  deadline: number;
  now: () => number;
}
const NO_BUDGET: GlBudget = { deadline: Infinity, now: Date.now };

/**
 * Pages ONE endpoint to completion (or the MAX_PAGES_PER_ENDPOINT bound, or the shared wall-clock
 * budget, whichever comes first). `xeroGet` already throws on any non-2xx response, so within this
 * loop a "stop" can only mean one of three THINGS THAT LOOK ALIKE BUT ARE NOT:
 *   (a) a genuinely EMPTY array under `arrayKey` — Xero's real, well-formed "no more records" last
 *       page. Stopping here is correct and complete; nothing to report.
 *   (b) `arrayKey` MISSING from the body, or present but not an array at all — a 2xx response whose
 *       shape does not match what this function expects (a vendor schema drift, a field rename, or
 *       any other anomaly). This is NOT "no more records"; it is "the response cannot be trusted to
 *       mean that". Silently treating it the same as (a) is exactly the failure mode `assembleGl`'s
 *       own module doc otherwise goes to great lengths never to allow: a caller sees `truncated:
 *       false`, no caveat, and a `variance` that LOOKS complete while actually being short. So (b)
 *       stops paging (this function makes no attempt to guess whether a later page would be normal
 *       again), reports exactly where it happened via `shapeAnomaly`, and marks the result
 *       `truncated` — the same signal an actual page-cap hit uses, so a caller who only checks
 *       `truncated` still gets warned; a caller who wants the precise reason gets `shapeAnomaly` too.
 *   (c) the shared wall-clock budget was exhausted before this page could be requested (checked
 *       BEFORE the fetch, never mid-fetch) — reported via the SAME `truncated`+`shapeAnomaly`
 *       mechanism as (b), since both mean "results from this endpoint are incomplete for this run"
 *       to any caller that only checks `truncated`; `shapeAnomaly`'s text distinguishes the reason.
 */
export async function fetchAllPaged(
  org: XeroOrg,
  path: string,
  arrayKey: string,
  where: string,
  deps?: TokenDeps,
  budget: GlBudget = NO_BUDGET,
): Promise<{ items: Record<string, unknown>[]; truncated: boolean; shapeAnomaly?: string }> {
  const items: Record<string, unknown>[] = [];
  let truncated = false;
  let shapeAnomaly: string | undefined;
  for (let page = 1; page <= MAX_PAGES_PER_ENDPOINT; page++) {
    if (budget.now() >= budget.deadline) {
      shapeAnomaly = `${path}: bounded wall-clock budget exhausted before page ${page} could be requested — results from this endpoint are INCOMPLETE for this run (not a page-cap hit; the caller's overall time budget ran out).`;
      truncated = true;
      break;
    }
    const res = await xeroGet(org, path, { page: String(page), where }, { deps });
    const arr = (res.body as Record<string, unknown>)?.[arrayKey];
    if (!Array.isArray(arr)) {
      shapeAnomaly = `${path} page ${page}: response body did not contain "${arrayKey}" as an array (got ${arr === undefined ? 'missing' : typeof arr}) — treated as a malformed/unexpected response shape, NOT an empty last page. Results from this endpoint are INCOMPLETE for this run.`;
      truncated = true;
      break;
    }
    if (arr.length === 0) break; // a real, well-formed empty array IS a legitimate last page
    items.push(...(arr as Record<string, unknown>[]));
    if (arr.length < 100) break; // short page = last page
    if (page === MAX_PAGES_PER_ENDPOINT) truncated = true;
  }
  return { items, truncated, shapeAnomaly };
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

/** Resume shape (FND-20260829-e454): identical to the tool's own from/to input, deliberately --
 *  call xero_gl_assemble again with these exact from/to (or assembleGl directly) to assemble the
 *  remainder under a fresh budget. No separate continuation-consuming code path is needed on this
 *  tool, unlike brain_search's deep mode: a "next chunk" of this range is just a normal call. */
export interface GlAssembleContinuation {
  from: string;
  to: string;
}

export interface GlAssembleResult {
  org: XeroOrg;
  from: string;
  to: string;
  months: GlAssembleMonth[];
  caveats: string[];
  methodology_note: string;
  /** True ONLY when the wall-clock budget was exhausted before every requested month could be
   *  assembled and/or before a full page-set of ManualJournals/Invoices/CreditNotes/
   *  BankTransactions could be fetched. `months` still contains every FULLY assembled month up to
   *  that point -- nothing already computed is discarded. Absent (not merely false) when the whole
   *  requested range completed, so a normal result's shape is unchanged by this fix. */
  partial?: true;
  /** Present only when partial is true. */
  continuation?: GlAssembleContinuation;
}

/** Wall-clock budget default for the WHOLE assembleGl call (TrialBalance loop + all four
 *  ManualJournals/Invoices/CreditNotes/BankTransactions page fetches). Safely under both the 40s
 *  target and ChatGPT's 45s hard cutoff even accounting for xeroGet's mandatory ~1.1s per-call rate
 *  spacing. Read fresh from process.env at the call site (same convention as brain_search's
 *  DEEP_RETRIEVAL_BUDGET_MS), so it can be tuned without a redeploy; always clamped to a hard
 *  ceiling so a misconfiguration can never defeat the point of this bound. */
const DEFAULT_GL_ASSEMBLE_BUDGET_MS = 32_000;
const MAX_GL_ASSEMBLE_BUDGET_MS = 40_000;

export function resolveGlAssembleBudgetMs(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GL_ASSEMBLE_BUDGET_MS;
  return Math.min(n, MAX_GL_ASSEMBLE_BUDGET_MS);
}

const METHODOLOGY_NOTE =
  'variance = tbMovement - manualJournalNet. tbMovement is Xero\'s own reported movement for that month, read directly from the ' +
  'TrialBalance period columns (NOT diffed against another month — see this file\'s CORRECTED module doc note for why diffing was ' +
  'wrong). manualJournalNet nets ONLY ManualJournals against it — a near-zero variance is a real completeness proof for accounts ' +
  'whose only activity was manual journals. Invoices/CreditNotes/BankTransactions line-item activity is returned separately in each ' +
  'month\'s `otherDocuments` (gross, unsigned, by account, THIS MONTH ONLY) and is NOT netted into variance — a nonzero variance on an ' +
  'account that also appears in that SAME month\'s otherDocuments is EXPECTED, not a defect. A month is OMITTED from `months` (with a ' +
  'caveat) when its own TrialBalance snapshot fails to parse. A TrialBalance row with no resolvable account identity is dropped but ' +
  'always surfaced as a caveat, never silently. A YTD-vs-period self-check runs on every month after the first and is reported as a ' +
  'caveat on disagreement (a financial-year boundary between two months is one legitimate, named cause).';

/**
 * Assembles the general ledger for one org over [from, to]: per-account TrialBalance movement
 * (read directly from each month's own snapshot, never diffed against another month's), netted
 * against ManualJournals, plus supporting Invoices/CreditNotes/BankTransactions detail, bucketed
 * per month. One call replaces what would otherwise be ~12 separate TrialBalance reads a year,
 * done client-side, every time (see module doc comment). Read-only; makes no writes.
 *
 * WALL-CLOCK BUDGETED (FND-20260829-e454, `opts`): xeroGet's mandatory ~1.1s per-call rate spacing
 * means the documented "one full year" acceptance test alone issues 12 sequential TrialBalance
 * calls, and the four document-endpoint page fetches can each independently take up to
 * MAX_PAGES_PER_ENDPOINT more -- easily exceeding a 45-second-class MCP client timeout. If the
 * shared deadline (default DEFAULT_GL_ASSEMBLE_BUDGET_MS, overridable via `opts.budgetMs`/
 * XERO_GL_ASSEMBLE_BUDGET_MS) is reached partway through the TrialBalance loop, the loop stops
 * (never mid-fetch) and the document window narrows to just the months that DID complete, so the
 * remaining budget is not wasted fetching documents for months that cannot be reported anyway. The
 * result comes back `partial:true` with a `continuation` naming the unprocessed remainder --
 * calling xero_gl_assemble again with that continuation's from/to (no special resume plumbing
 * needed; it is the SAME from/to shape the tool already takes) assembles the rest under a fresh
 * budget. `opts` is entirely optional and defaults to a real (Date.now-based) budget, so every
 * EXISTING direct caller/test that passes only (org, from, to, deps) is unaffected in practice (a
 * fast mocked test never approaches a 32s real-clock deadline).
 */
export async function assembleGl(
  org: XeroOrg,
  from: string,
  to: string,
  deps?: TokenDeps,
  opts?: { budgetMs?: number; now?: () => number },
): Promise<GlAssembleResult> {
  const now = opts?.now ?? Date.now;
  const budgetMs = opts?.budgetMs ?? resolveGlAssembleBudgetMs(process.env.XERO_GL_ASSEMBLE_BUDGET_MS);
  const budget: GlBudget = { deadline: now() + budgetMs, now };

  const caveats: string[] = [];
  const allDates = monthEndDates(from, to);
  const requestedDates = allDates.slice(1); // allDates[0] is a leading boundary marker, not a month we report on

  // 1. TrialBalance ONCE per requested month-end, STOPPING EARLY if the budget runs out (checked
  // before each date's fetch, never mid-fetch). Each month's period Debit/Credit pair IS that
  // month's movement already (see the module CORRECTED note) -- read directly, never diffed.
  const monthSnapshots: ParsedTrialBalance[] = [];
  for (const date of requestedDates) {
    if (budget.now() >= budget.deadline) break;
    const res = await xeroGet(org, '/Reports/TrialBalance', { date }, { deps });
    const parsed = parseTrialBalanceRows(res.body);
    if (parsed.rows.length === 0) {
      caveats.push(`TrialBalance at ${date} parsed to 0 rows — treated as an invalid/unparseable snapshot, not a real balance. This month is OMITTED from months.`);
    }
    if (parsed.unresolvedRowCount > 0) {
      caveats.push(`TrialBalance at ${date}: ${parsed.unresolvedRowCount} row(s) had no resolvable account name or GUID and were DROPPED — those accounts are MISSING from this month's figures (not zero, just absent). Investigate the raw report rows for this date before treating this month as complete.`);
    }
    monthSnapshots.push(parsed);
  }

  // Nothing at all could be assembled within budget -- not even the first month's TrialBalance.
  // Skip the document fetches entirely (there is no month to attach them to yet) and hand back an
  // honest, resumable partial rather than spending the whole call on document data for a range
  // that cannot be reported.
  if (monthSnapshots.length === 0 && requestedDates.length > 0) {
    return {
      org,
      from,
      to,
      months: [],
      caveats: [
        ...caveats,
        `The wall-clock budget (${budgetMs}ms) was exhausted before even the first requested month's TrialBalance could be read. Nothing was assembled this call.`,
      ],
      methodology_note: METHODOLOGY_NOTE,
      partial: true,
      continuation: { from, to },
    };
  }

  const processedDates = requestedDates.slice(0, monthSnapshots.length);
  const budgetTruncatedMonths = processedDates.length < requestedDates.length;
  // The document fetches (ManualJournals/Invoices/CreditNotes/BankTransactions) still widen to
  // whole calendar months, so a partial-month request (e.g. from=2026-03-05) never scopes its
  // document window narrower than the month it's reporting on. When the TrialBalance loop stopped
  // early, this window also narrows to the months that actually completed, rather than the
  // originally requested range, so the remaining budget is not spent fetching documents for months
  // this call cannot report on anyway.
  const effectiveFrom = firstDayOfMonth(processedDates[0]!);
  const effectiveTo = processedDates[processedDates.length - 1]!;
  const effectiveWhere = dateWhere(effectiveFrom, effectiveTo);

  // 2. ManualJournals across the EFFECTIVE (widened) range, bucketed by month. Server-side filtered
  // to POSTED only (reviewer-caught, 2026-07-30): DRAFT and VOIDED journals never hit the Trial
  // Balance, so summing them into manualJournalNet would disagree with the real TB for reasons that
  // have nothing to do with a genuine reconciliation gap. sumManualJournalsByAccount also re-checks
  // Status client-side as a second layer, in case a future caller ever bypasses this where clause.
  const mjWhere = `${effectiveWhere} && Status=="POSTED"`;
  const mjRes = await fetchAllPaged(org, '/ManualJournals', 'ManualJournals', mjWhere, deps, budget);
  if (mjRes.truncated) caveats.push(mjRes.shapeAnomaly ?? `ManualJournals hit the ${MAX_PAGES_PER_ENDPOINT}-page cap (${MAX_PAGES_PER_ENDPOINT * 100}+ records) — some journals in range may be missing from manualJournalNet.`);
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
  const invRes = await fetchAllPaged(org, '/Invoices', 'Invoices', effectiveWhere, deps, budget);
  if (invRes.truncated) caveats.push(invRes.shapeAnomaly ?? `Invoices hit the ${MAX_PAGES_PER_ENDPOINT}-page cap — invoicesLineGrossByAccount is incomplete for one or more months.`);
  const cnRes = await fetchAllPaged(org, '/CreditNotes', 'CreditNotes', effectiveWhere, deps, budget);
  if (cnRes.truncated) caveats.push(cnRes.shapeAnomaly ?? `CreditNotes hit the ${MAX_PAGES_PER_ENDPOINT}-page cap — creditNotesLineGrossByAccount is incomplete for one or more months.`);
  const btRes = await fetchAllPaged(org, '/BankTransactions', 'BankTransactions', effectiveWhere, deps, budget);
  if (btRes.truncated) caveats.push(btRes.shapeAnomaly ?? `BankTransactions hit the ${MAX_PAGES_PER_ENDPOINT}-page cap — bankTransactionsLineGrossByAccount is incomplete for one or more months.`);

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

  // 4. Per-month: read TB movement directly, net ManualJournals, compute variance. Skip (omit,
  // caveat already logged in step 1) any month whose own snapshot was invalid. Bounded to
  // monthSnapshots.length (== processedDates.length), NOT requestedDates.length -- when the
  // TrialBalance loop above stopped early, monthSnapshots is SHORTER than requestedDates, and
  // indexing past its end would read undefined. Identical to the pre-budget behavior whenever
  // nothing was truncated (processedDates then equals requestedDates exactly).
  const months: GlAssembleMonth[] = [];
  for (let i = 0; i < monthSnapshots.length; i++) {
    const periodEnd = processedDates[i]!;
    const snapshot = monthSnapshots[i]!;
    if (snapshot.rows.length === 0) continue;
    // firstDayOfMonth(periodEnd) is used for EVERY entry, not just i===0 (Copilot-caught, 2026-07-30,
    // round 3: using requestedDates[i-1], a prior MONTH-END date, for i>0 made that month's periodStart
    // equal the PRIOR month's periodEnd — an overlapping, inconsistent boundary. For i===0 this is
    // exactly equal to effectiveFrom, since effectiveFrom is itself firstDayOfMonth(requestedDates[0]).
    const periodStart = firstDayOfMonth(periodEnd);
    const [ey, em] = periodEnd.split('-').map(Number);
    const monthKey = `${ey}-${String(em).padStart(2, '0')}`;
    const mjBody = { ManualJournals: mjByMonth.get(monthKey) ?? [] };
    const mjNet = sumManualJournalsByAccount(mjBody);

    let nonzeroVarianceCount = 0;
    // Build over the UNION of TB-movement keys and manual-journal keys, not just the TB side
    // (reviewer-caught, 2026-07-30): a key present only in mjNet — e.g. the documented fallback
    // case where the TB parser emits `name:...` but a journal's AccountID resolves to a distinct
    // `code:...` key for the same real account — was previously silently dropped, hiding exactly
    // the "unmatched journal side" this tool's own methodology promises to surface. A journal-only
    // key gets tbMovement:0 (there was no TB movement recorded under that key) so its full
    // manualJournalNet surfaces as the variance, which is the honest signal that something didn't
    // line up rather than the mismatch vanishing from the output entirely.
    const tbByAccount = new Map(snapshot.rows.map((r) => [r.accountId, r]));
    const allKeys = new Set<string>([...tbByAccount.keys(), ...mjNet.keys()]);
    const accounts: GlAssembleAccountRow[] = [...allKeys].map((accountId) => {
      const tb = tbByAccount.get(accountId);
      const manualJournalNet = mjNet.get(accountId) ?? 0;
      const tbMovement = tb ? round2(tb.debit - tb.credit) : 0;
      const variance = round2(tbMovement - manualJournalNet);
      if (variance !== 0) nonzeroVarianceCount++;
      return { accountId, name: tb?.name ?? accountId, tbMovement, manualJournalNet, variance };
    });

    // SELF-CHECK (cheap: uses rows already fetched, no extra API call): for every month after the
    // first requested one, period(this month) should equal YTD(this) - YTD(prior month) for the
    // SAME account. A mismatch is surfaced as a caveat -- it may be a genuine financial-year
    // boundary between the two months (YTD legitimately resets there), or a real data issue; this
    // check does not try to tell those apart, it just makes sure neither passes silently.
    //
    // Compares against the ACTUAL `tbMovement` value emitted in `accounts` above (via
    // tbMovementByAccount), not an independently re-derived `r.debit - r.credit` formula
    // (Copilot-caught, 2026-07-30, round 3: recomputing the same formula in two places means a
    // future regression in the REAL tbMovement computation -- e.g. reintroducing differencing --
    // would not trip this check, since both places would need to be changed together for the
    // check to ever disagree with itself). Reading from tbMovementByAccount means this check
    // verifies what the tool actually SHIPS, so any future change to how tbMovement is computed
    // is automatically covered without touching this block.
    //
    // Skipped entirely when the PRIOR month's own TrialBalance snapshot was invalid (0 rows, see
    // step 1's caveat) (Copilot-caught, 2026-07-30, round 3): an empty prior snapshot means
    // priorYtdByAccount has no entries, so every account would look like it has a prior YTD of 0
    // and this month would appear to mismatch for EVERY account -- a fabricated caveat storm, not
    // a real finding, on an otherwise-valid month.
    if (i > 0 && monthSnapshots[i - 1].rows.length > 0) {
      const tbMovementByAccount = new Map(accounts.map((a) => [a.accountId, a.tbMovement]));
      const priorYtdByAccount = new Map(monthSnapshots[i - 1].rows.map((r) => [r.accountId, round2(r.ytdDebit - r.ytdCredit)]));
      let mismatchCount = 0;
      for (const r of snapshot.rows) {
        const priorYtd = priorYtdByAccount.get(r.accountId);
        if (priorYtd === undefined) continue; // account did not exist in the prior snapshot at all -- a new account, not a self-check mismatch
        const thisYtd = round2(r.ytdDebit - r.ytdCredit);
        const expectedPeriod = round2(thisYtd - priorYtd);
        const actualMovement = tbMovementByAccount.get(r.accountId) ?? round2(r.debit - r.credit);
        if (Math.abs(expectedPeriod - actualMovement) > 0.01) mismatchCount++;
      }
      if (mismatchCount > 0) {
        caveats.push(`${periodEnd}: ${mismatchCount} account(s) where period movement disagrees with YTD(this month) - YTD(prior month) by more than a cent. A financial-year boundary between these two months is one legitimate cause (YTD resets there); otherwise treat as a data-integrity flag for this month.`);
      }
    }
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
  if (months.length === 0 && processedDates.length > 0) {
    caveats.push('Every processed month touched an invalid TrialBalance snapshot — months is empty. See the per-date caveats above.');
  }

  const result: GlAssembleResult = { org, from, to, months, caveats, methodology_note: METHODOLOGY_NOTE };
  if (budgetTruncatedMonths) {
    result.partial = true;
    // The remainder starts the calendar month AFTER the last one this call actually processed --
    // firstDayOfMonth's own month-boundary math, applied to the NEXT requested date, keeps this
    // exact regardless of how from/to's original days-of-month were specified.
    result.continuation = { from: firstDayOfMonth(requestedDates[processedDates.length]!), to };
    caveats.push(
      `The wall-clock budget (${budgetMs}ms) was exhausted after assembling ${processedDates.length}/${requestedDates.length} requested month(s). ` +
        `Call again with from="${result.continuation.from}" (continuation.from) to assemble the remainder.`,
    );
  }
  return result;
}
