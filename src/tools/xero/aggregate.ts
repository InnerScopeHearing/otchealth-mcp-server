/**
 * xero_aggregate — server-side count/sum over a WHOLE Xero population, grouped (issue #291b).
 *
 * WHY THIS EXISTS: the CFO census work ("how many AUTHORISED credit notes still carry remaining
 * credit, and what do they total", "how many payments landed in each of 2021/2022/2023") has no
 * server-side answer in Xero — the accounting API has no COUNT/SUM/GROUP BY, only paged record
 * lists. So every such question was answered by pulling the raw population through the gateway and
 * counting it client-side: 5 to 10 JIT-offloaded chunks PER QUERY, each of which the caller then
 * had to page back in and add up by hand. That is expensive, slow, and — the real problem — it is
 * arithmetic done by a language model over paginated text, which is exactly the kind of work that
 * fails silently. This tool does the same paging ONCE, server-side, and returns only the reduced
 * figures (counts + sums per group), which is small enough that it never JIT-offloads in practice.
 *
 * DESIGN NOTES (deliberate, please read before "simplifying" any of them):
 *
 *   - PURE REDUCER, SEPARATE FROM I/O. `reduceAggregate` takes records in and returns groups out
 *     with no network, no clock, no org. Every arithmetic claim this tool makes is therefore
 *     directly unit-testable against fixtures (aggregate.test.ts) — mirroring gl-assemble.ts's
 *     parseTrialBalanceRows/sumManualJournalsByAccount split, and for the same reason: a financial
 *     figure whose derivation is only exercised through a live API call is not actually tested.
 *
 *   - DELETED/VOIDED RECORDS ARE EXCLUDED BY DEFAULT. Every other xero_* list tool's description
 *     carries the same warning in prose ("add Status==\"AUTHORISED\" or you will fabricate
 *     exceptions that do not exist") because Xero returns DELETED/VOIDED records in the default
 *     population. Prose in a description is advice a caller can forget; here the default is safe
 *     (include_deleted:false prepends Status==\"AUTHORISED\") and the caller must opt OUT. A caller
 *     who supplies their own `where` mentioning Status is trusted and never second-guessed.
 *
 *   - DATE FILTERING IS CLIENT-SIDE, ON PURPOSE. Xero's `where` DateTime syntax differs per
 *     endpoint and silently no-ops on some of them (/BankTransfers ignores `where` entirely —
 *     confirmed live, see xero_bank_transfers' shim in tools.ts). A filter that silently does
 *     nothing while the summary claims it was applied is worse than no filter, so fromDate/toDate
 *     are applied here, to parsed record dates, where the behaviour is provable. A record whose
 *     Date cannot be parsed is KEPT (never silently dropped from a count) and reported in caveats.
 *
 *   - AccountCode / LineAmount EXPLODE THE LINES. A record-level grouping cannot answer "by
 *     account", because the account lives on the LINES (LineItems for Invoices/CreditNotes/
 *     BankTransactions; JournalLines for ManualJournals). When AccountCode is grouped on, or
 *     LineAmount is summed, each line contributes to its own bucket. A RECORD-level metric (Total,
 *     AmountDue, ...) is then added ONCE PER (group, record) pair rather than once per line — a
 *     three-line invoice must not contribute 3x its Total to a bucket. That is a real, load-bearing
 *     subtlety, so it is stated in the caveats of every exploded result rather than left implicit.
 *
 *   - AmountDue/AmountPaid/RemainingCredit ARE CURRENT-STATE, NOT AS-AT. Xero stores one live value
 *     per record; there is no historical AmountDue. Summing them with a fromDate/toDate filter
 *     therefore answers "what is outstanding TODAY on records dated in that window", NOT "what was
 *     outstanding at the end of that window". Both are legitimate questions and they have different
 *     answers; the caveat exists so a reader never mistakes one for the other.
 *
 * READ-ONLY. EXEC_RING-gated at the tool boundary (tools.ts), same as every other xero_* tool.
 */
import { type XeroOrg, type TokenDeps, xeroGet } from './client.js';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export const AGGREGATE_RESOURCES = [
  'Invoices',
  'CreditNotes',
  'Payments',
  'BankTransactions',
  'ManualJournals',
  'BankTransfers',
] as const;
export type AggregateResource = (typeof AGGREGATE_RESOURCES)[number];

export const AGGREGATE_GROUP_BYS = [
  'Status',
  'Type',
  'ContactID',
  'ContactName',
  'Year',
  'Month',
  'AccountCode',
  'BankAccountID',
] as const;
export type AggregateGroupBy = (typeof AGGREGATE_GROUP_BYS)[number];

export const AGGREGATE_METRICS = [
  'Total',
  'SubTotal',
  'TotalTax',
  'AmountDue',
  'AmountPaid',
  'AmountCredited',
  'RemainingCredit',
  'Amount',
  'LineAmount',
] as const;
export type AggregateMetric = (typeof AGGREGATE_METRICS)[number];

/** The only metric that lives on a LINE rather than on the record itself. */
const LINE_METRIC: AggregateMetric = 'LineAmount';

/** Placeholder key value for a record/line that simply does not carry the grouped field. */
export const MISSING_KEY = '(none)';

/** Xero's list pages are 100 records; a short page is the last page. */
const PAGE_SIZE = 100;

export type XeroRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Parses a Xero date. List endpoints return either the .NET form `/Date(1620000000000+0000)/`
 * (epoch MILLISECONDS, optionally with a trailing timezone offset which Xero itself documents as
 * always UTC for these fields) or a plain ISO `2021-05-03T00:00:00` / `2021-05-03`. Returns null —
 * never a NaN Date, never a silent 1970 — for anything else, so a caller can distinguish
 * "unparseable" from "parsed" instead of comparing against NaN (every NaN comparison is false,
 * which is how an unvalidated date filter silently matches everything). Pure.
 */
export function parseXeroDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const dotNet = /\/Date\((-?\d+)/.exec(raw);
  const d = dotNet ? new Date(Number(dotNet[1])) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The record's own transaction date, whichever field this resource carries it in. Pure. */
export function recordDate(record: XeroRecord): Date | null {
  return parseXeroDate(record.Date) ?? parseXeroDate(record.DateString);
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v;
  return null;
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * The line array for a resource: JournalLines for ManualJournals, LineItems for the three document
 * types that carry them. Payments and BankTransfers have NO per-account line breakdown at all (they
 * reference an invoice / two bank accounts), so they explode to nothing — see the caveats emitted
 * by reduceAggregate. Pure.
 */
export function linesOf(record: XeroRecord, resource: AggregateResource): XeroRecord[] {
  const key = resource === 'ManualJournals' ? 'JournalLines' : 'LineItems';
  const arr = record[key];
  return Array.isArray(arr) ? (arr as XeroRecord[]) : [];
}

/** True when this request needs line-level detail (and therefore line explosion). Pure. */
export function needsLineExplosion(
  group_by: readonly AggregateGroupBy[],
  metrics: readonly AggregateMetric[],
): boolean {
  return group_by.includes('AccountCode') || metrics.includes(LINE_METRIC);
}

function bankAccountIdOf(record: XeroRecord): string | null {
  for (const field of ['BankAccount', 'FromBankAccount', 'ToBankAccount', 'Account'] as const) {
    const acct = record[field];
    if (acct && typeof acct === 'object') {
      const a = acct as XeroRecord;
      const hit = str(a.AccountID) ?? str(a.Code);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The group key for one record (and, when exploding, one of its lines). Every dimension resolves to
 * a STRING — including the deliberate MISSING_KEY placeholder — so two records that differ only by
 * "field absent" vs "field empty string" can never land in two visually identical buckets. Pure.
 */
export function groupKeyOf(
  record: XeroRecord,
  line: XeroRecord | null,
  group_by: readonly AggregateGroupBy[],
  date: Date | null,
): Record<string, string> {
  const key: Record<string, string> = {};
  const contact = (record.Contact && typeof record.Contact === 'object' ? record.Contact : {}) as XeroRecord;
  for (const dim of group_by) {
    let value: string | null = null;
    switch (dim) {
      case 'Status':
        value = str(record.Status);
        break;
      case 'Type':
        value = str(record.Type);
        break;
      case 'ContactID':
        value = str(contact.ContactID);
        break;
      case 'ContactName':
        value = str(contact.Name);
        break;
      case 'Year':
        value = date ? String(date.getUTCFullYear()) : null;
        break;
      case 'Month':
        value = date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` : null;
        break;
      case 'AccountCode':
        // AccountCode is the human-facing key the CFO asks in, but a line may carry only the GUID
        // (and Xero's own posting engine sometimes omits the code). Fall back to the AccountID
        // rather than dumping every such line into one undifferentiated "(none)" bucket.
        value = line ? str(line.AccountCode) ?? (str(line.AccountID) ? `id:${str(line.AccountID)}` : null) : null;
        break;
      case 'BankAccountID':
        value = bankAccountIdOf(record);
        break;
    }
    key[dim] = value ?? MISSING_KEY;
  }
  return key;
}

/** Stable, order-independent identity for a group key (also its sort order). Pure. */
export function groupKeyString(key: Record<string, string>): string {
  return Object.keys(key)
    .sort()
    .map((k) => `${k}=${key[k]}`)
    .join('|');
}

// ---------------------------------------------------------------------------------------------
// The reducer (pure)
// ---------------------------------------------------------------------------------------------

export interface AggregateGroup {
  key: Record<string, string>;
  count: number;
  sums: Record<string, number>;
}

export interface ReduceOptions {
  resource: AggregateResource;
  group_by: readonly AggregateGroupBy[];
  metrics: readonly AggregateMetric[];
  fromDate?: string;
  toDate?: string;
}

export interface ReduceResult {
  /** Records that survived the client-side date filter — the population these groups describe. */
  itemCount: number;
  groups: AggregateGroup[];
  caveats: string[];
}

/**
 * Reduces a fetched population to counts + summed metrics per group. Pure: no network, no clock.
 *
 * `count` semantics, stated explicitly because they differ by mode and a silently-wrong count is
 * the whole failure this tool exists to remove:
 *   - NOT exploding: count = number of RECORDS in the group.
 *   - Exploding (AccountCode grouped, or LineAmount summed): count = number of LINES in the group.
 * In exploding mode a record-level metric (Total/AmountDue/...) is added ONCE per (group, record),
 * never once per line, so a 3-line invoice contributes its Total once — not three times.
 */
export function reduceAggregate(records: readonly XeroRecord[], opts: ReduceOptions): ReduceResult {
  const group_by = opts.group_by;
  const metrics = opts.metrics.length ? opts.metrics : (['Total'] as AggregateMetric[]);
  const explode = needsLineExplosion(group_by, metrics);
  const caveats: string[] = [];

  const fromMs = opts.fromDate ? Date.parse(`${opts.fromDate}T00:00:00Z`) : undefined;
  const toMs = opts.toDate ? Date.parse(`${opts.toDate}T23:59:59.999Z`) : undefined;

  const buckets = new Map<string, AggregateGroup>();
  /** group key -> record indices whose RECORD-level metrics were already added to that group. */
  const recordSeen = new Map<string, Set<number>>();
  let itemCount = 0;
  let unparseableDates = 0;
  let recordsWithNoLines = 0;

  records.forEach((record, index) => {
    const date = recordDate(record);
    if (fromMs !== undefined || toMs !== undefined) {
      if (!date) {
        // Keep it. Dropping a record because WE could not read its date would understate a count
        // while looking clean — the caveat below makes the ambiguity visible instead.
        unparseableDates++;
      } else {
        const ms = date.getTime();
        if (fromMs !== undefined && ms < fromMs) return;
        if (toMs !== undefined && ms > toMs) return;
      }
    }
    itemCount++;

    const contributions: Array<XeroRecord | null> = explode ? linesOf(record, opts.resource) : [null];
    if (explode && contributions.length === 0) {
      // A record with no lines still exists and still has record-level metrics; bucket it under the
      // MISSING_KEY account rather than dropping it out of the population silently.
      recordsWithNoLines++;
      contributions.push(null);
    }

    for (const line of contributions) {
      const key = groupKeyOf(record, line, group_by, date);
      const id = groupKeyString(key);
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = { key, count: 0, sums: Object.fromEntries(metrics.map((m) => [m, 0])) };
        buckets.set(id, bucket);
      }
      bucket.count++;
      let seen = recordSeen.get(id);
      if (!seen) {
        seen = new Set<number>();
        recordSeen.set(id, seen);
      }
      const recordAlreadyCounted = seen.has(index);
      seen.add(index);
      for (const metric of metrics) {
        if (metric === LINE_METRIC) {
          bucket.sums[metric] = (bucket.sums[metric] ?? 0) + (line ? num(line.LineAmount) : num(record.LineAmount));
        } else if (!recordAlreadyCounted) {
          bucket.sums[metric] = (bucket.sums[metric] ?? 0) + num(record[metric]);
        }
      }
    }
  });

  const groups = [...buckets.values()]
    .map((g) => ({
      key: g.key,
      count: g.count,
      sums: Object.fromEntries(Object.entries(g.sums).map(([k, v]) => [k, round2(v)])),
    }))
    .sort((a, b) => (groupKeyString(a.key) < groupKeyString(b.key) ? -1 : 1));

  if (explode) {
    caveats.push(
      'Line-exploded (AccountCode grouped and/or LineAmount summed): `count` is a LINE count, not a record count. ' +
        'Record-level metrics (Total/SubTotal/TotalTax/AmountDue/AmountPaid/AmountCredited/RemainingCredit/Amount) are ' +
        'added once per (group, record), never once per line, so a multi-line document does not multiply its own Total.',
    );
    if (opts.resource === 'Payments' || opts.resource === 'BankTransfers') {
      caveats.push(
        `${opts.resource} carry no per-account line breakdown in Xero (they reference an invoice / two bank accounts), ` +
          'so AccountCode/LineAmount cannot be derived for this resource — those buckets will be empty or "(none)".',
      );
    }
    if (recordsWithNoLines) {
      caveats.push(
        `${recordsWithNoLines} record(s) carried no line array at all and were bucketed under AccountCode="${MISSING_KEY}".`,
      );
    }
  }
  if (unparseableDates) {
    caveats.push(
      `${unparseableDates} record(s) had an unparseable Date and were KEPT in the population despite the fromDate/toDate ` +
        'filter (never silently dropped — a dropped record understates a count while looking clean).',
    );
  }
  if (metrics.some((m) => m === 'AmountDue' || m === 'AmountPaid' || m === 'RemainingCredit' || m === 'AmountCredited')) {
    caveats.push(
      'AmountDue/AmountPaid/AmountCredited/RemainingCredit are CURRENT-STATE, not as-at: Xero stores one live value per ' +
        'record and keeps no history of it. With a date filter this answers "outstanding TODAY on records dated in that ' +
        'window", NOT "outstanding at the end of that window".',
    );
  }

  return { itemCount, groups, caveats };
}

// ---------------------------------------------------------------------------------------------
// where-clause construction (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The `where` actually sent to Xero. When include_deleted is false and the caller's own filter does
 * not already mention Status, `Status=="AUTHORISED"` is prepended (joined with " AND ") so a count
 * never silently includes DELETED/VOIDED records — the documented way every other xero_* list tool
 * fabricates exceptions that do not exist. A caller who names Status themselves is trusted and left
 * exactly as written. Pure.
 */
export function buildAggregateWhere(where: string | undefined, includeDeleted: boolean): string | undefined {
  const own = where?.trim() || '';
  if (includeDeleted) return own || undefined;
  if (/\bStatus\b/i.test(own)) return own;
  const guard = 'Status=="AUTHORISED"';
  return own ? `${guard} AND ${own}` : guard;
}

// ---------------------------------------------------------------------------------------------
// Orchestrator (paging + budget), mirroring gl-assemble.ts's fetchAllPaged contract
// ---------------------------------------------------------------------------------------------

/** Same shape and reasoning as gl-assemble.ts's GlBudget — one shared wall clock for the whole call. */
export interface AggregateBudget {
  deadline: number;
  now: () => number;
}

const DEFAULT_AGGREGATE_BUDGET_MS = 32_000;
const MAX_AGGREGATE_BUDGET_MS = 40_000;

/** Same clamped, env-tunable contract as resolveGlAssembleBudgetMs in gl-assemble.ts. Pure. */
export function resolveAggregateBudgetMs(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AGGREGATE_BUDGET_MS;
  return Math.min(n, MAX_AGGREGATE_BUDGET_MS);
}

export interface AggregateInput {
  resource: AggregateResource;
  where?: string;
  include_deleted?: boolean;
  fromDate?: string;
  toDate?: string;
  group_by?: readonly AggregateGroupBy[];
  metrics?: readonly AggregateMetric[];
  max_pages?: number;
}

export interface AggregateResult {
  org: XeroOrg;
  resource: AggregateResource;
  where_sent: string | null;
  group_by: AggregateGroupBy[];
  metrics: AggregateMetric[];
  /** Records in the population AFTER the client-side date filter. */
  itemCount: number;
  /** Pages actually fetched (BankTransfers is always 1 — its endpoint has no server-side paging). */
  pageCount: number;
  groups: AggregateGroup[];
  caveats: string[];
  /** Present only when paging stopped early (page cap, budget, or a malformed response shape). */
  truncated?: true;
}

/**
 * Fetches one resource's full population for an org and reduces it in memory.
 *
 * Paging follows gl-assemble.ts's fetchAllPaged rules exactly, for the same reasons: `xeroGet`
 * already throws on any non-2xx, so a stop can only mean (a) a genuine empty/short last page —
 * complete, nothing to report; (b) a 2xx whose body does not carry the expected array, which is NOT
 * "no more records" and is reported as a caveat + `truncated`; or (c) the shared wall-clock budget
 * running out before the next page could even be requested — also caveat + `truncated`, since a
 * caller checking only `truncated` must still be warned that the count is short. `xeroGet` enforces
 * its own ~1.1s per-org spacing (client.ts MIN_SPACING_MS), which is this loop's rate-limit
 * backoff — never add a second, competing spacer here.
 *
 * BankTransfers is a single unpaged fetch: its endpoint ignores `page` AND `where` server-side
 * (confirmed live — see xero_bank_transfers' shim in tools.ts), so asking for either would produce
 * a filtered-looking result that was never actually filtered.
 */
export async function aggregateXero(
  org: XeroOrg,
  input: AggregateInput,
  deps?: TokenDeps,
  opts?: { budgetMs?: number; now?: () => number },
): Promise<AggregateResult> {
  const now = opts?.now ?? Date.now;
  const budgetMs = opts?.budgetMs ?? resolveAggregateBudgetMs(process.env.XERO_AGGREGATE_BUDGET_MS);
  const budget: AggregateBudget = { deadline: now() + budgetMs, now };

  const group_by = [...(input.group_by ?? [])];
  const metrics = [...(input.metrics ?? ['Total' as AggregateMetric])];
  const maxPages = Math.max(1, input.max_pages ?? 200);
  const includeDeleted = input.include_deleted ?? false;
  const fetchCaveats: string[] = [];
  const records: XeroRecord[] = [];
  let pageCount = 0;
  let truncated = false;

  if (input.resource === 'BankTransfers') {
    const res = await xeroGet(org, '/BankTransfers', {}, { deps });
    const arr = (res.body as Record<string, unknown>)?.BankTransfers;
    pageCount = 1;
    if (Array.isArray(arr)) {
      records.push(...(arr as XeroRecord[]));
    } else {
      truncated = true;
      fetchCaveats.push(
        '/BankTransfers: response body did not contain "BankTransfers" as an array — treated as a malformed response, ' +
          'NOT an empty population. This result is INCOMPLETE.',
      );
    }
    fetchCaveats.push(
      "/BankTransfers ignores both `page` and `where` server-side (confirmed live), so the org's ENTIRE transfer history " +
        'is fetched on every call and include_deleted/where are not applied by Xero. fromDate/toDate still apply (client-side).',
    );
  } else {
    const where = buildAggregateWhere(input.where, includeDeleted);
    for (let page = 1; page <= maxPages; page++) {
      if (budget.now() >= budget.deadline) {
        truncated = true;
        fetchCaveats.push(
          `/${input.resource}: wall-clock budget exhausted before page ${page} could be requested — this population is ` +
            'INCOMPLETE for this run (not a page-cap hit). Narrow `where`/date range, or re-run.',
        );
        break;
      }
      const res = await xeroGet(org, `/${input.resource}`, { page: String(page), where }, { deps });
      const body = res.body as Record<string, unknown> | undefined;
      const arr = body?.[input.resource];
      if (!Array.isArray(arr)) {
        truncated = true;
        fetchCaveats.push(
          `/${input.resource} page ${page}: response body did not contain "${input.resource}" as an array (got ` +
            `${arr === undefined ? 'missing' : typeof arr}) — treated as a malformed/unexpected response shape, NOT an ` +
            'empty last page. This population is INCOMPLETE for this run.',
        );
        break;
      }
      pageCount = page;
      if (arr.length === 0) break; // a real, well-formed empty array IS a legitimate last page
      records.push(...(arr as XeroRecord[]));
      if (arr.length < PAGE_SIZE) break; // short page = last page
      const pagination = body?.pagination as { pageCount?: number } | undefined;
      if (typeof pagination?.pageCount === 'number' && page >= pagination.pageCount) break;
      if (page === maxPages) {
        truncated = true;
        fetchCaveats.push(
          `/${input.resource}: hit the max_pages cap (${maxPages}) with a full page still returning records — this ` +
            'population is INCOMPLETE. Raise max_pages or narrow `where`.',
        );
      }
    }
  }

  const reduced = reduceAggregate(records, {
    resource: input.resource,
    group_by,
    metrics,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });

  return {
    org,
    resource: input.resource,
    where_sent: input.resource === 'BankTransfers' ? null : buildAggregateWhere(input.where, includeDeleted) ?? null,
    group_by,
    metrics,
    itemCount: reduced.itemCount,
    pageCount,
    groups: reduced.groups,
    caveats: [...fetchCaveats, ...reduced.caveats],
    ...(truncated ? { truncated: true as const } : {}),
  };
}
