/**
 * ROOM HYGIENE -- DEMOTE (never hard-delete) OPERATIONAL EXHAUST in knowledge queries by default.
 *
 * ============================ THE PROBLEM ============================
 * The `memory-exec` index (and its per-ring siblings `finance-cfo-memory` / `legal-personal-memory`,
 * built by the same writer -- see skills/ring-memory-index and skills/kb-memory/semantic.mjs in the
 * toolkit repo) carries EVERY row an agent's ledger publishes to the shared feed, not just durable
 * knowledge. In particular `type: 'status'` ("what I'm working on") is auto-shared on EVERY
 * `mem.mjs status` call -- it is high-volume, low-signal chatter by design, not a fact/decision/
 * correction/pitfall. Left unfiltered, a `brain_search`/`kb_search` query gets diluted by this
 * operational exhaust: a real fact can rank behind a pile of "still working on X" status rows that
 * happen to share vocabulary with the query.
 *
 * KNOWLEDGE (never demoted, regardless of the list below) = the 4 durable types memory_remember
 * itself accepts for durable recall: fact, decision, correction, pitfall (see
 * src/tools/memory/remember.ts TYPES -- note memory_remember also accepts 'status' at WRITE time;
 * this module governs READ-time precision, a different axis).
 *
 * ============================ 2026-07-21 CORRECTION: DEMOTE, DO NOT HARD-DELETE ============================
 * This module used to HARD-EXCLUDE every exhaust type from default results: a server-side Azure AI
 * Search $filter (buildExhaustFilterClause) removed them at the query layer, and a client-side
 * backstop (the old `filterExhaustHits`) dropped any that slipped through. A live-measured recall
 * regression (nightly-recall-eval hit@5 dropped from a 97.7% baseline to ~75%) was traced partly to
 * this: some genuinely useful content is typed as exhaust (a status/episode row that happens to
 * carry a fact worth surfacing, or a query whose single best-matching document IS an excluded type
 * with nothing equally good to replace it), and a HARD exclude made that content TOTALLY INVISIBLE
 * rather than merely deprioritized -- the caller could not get it back short of `include_ops:true`,
 * which most callers never think to try.
 *
 * The fix is DEMOTION, not deletion. `demoteExhaustHits` (below) re-ranks instead of removes: every
 * exhaust-typed hit sorts AFTER every non-exhaust hit (each group keeping its own relative order),
 * so operational chatter never crowds out genuine knowledge at the top of a result set, but it is
 * still THERE if the room genuinely has nothing better -- a caller asking "what has the CFO been
 * doing lately" (or a query that only ever matched a status row) still gets an answer instead of an
 * empty/truncated one. This is a pure re-rank-then-truncate: a room with 8 non-exhaust hits and a
 * `top` of 5 returns only those 5 genuine hits, exhaust never displaces them; a room with only 2
 * non-exhaust hits and a `top` of 5 returns those 2 PLUS 3 exhaust hits to fill the remaining slots,
 * instead of a truncated 2-hit answer.
 *
 * Consequently the hard server-side $filter is no longer applied automatically: a $filter can only
 * ever EXCLUDE (Azure AI Search has no notion of "rank this lower"), so it is structurally incapable
 * of demotion -- the re-rank has to happen client-side, after retrieval, once the excluded rows are
 * actually IN HAND to be reordered. `buildExhaustFilterClause` is kept as an explicit, opt-in helper
 * for a caller that genuinely wants the OLD strict-exclusion behavior (pass its output as
 * `HybridSearchOptions.filter` -- see azure/search.ts); nothing in this codebase applies it by
 * default any more. See azure/search.ts's hybridSearch for exactly how the default query (no
 * `opts.filter` given) now fetches a wider unfiltered candidate pool and demotes+truncates client
 * side instead of filtering server side.
 *
 * `include_ops` keeps its existing name and its existing "true = give me everything, exactly as
 * before" meaning (full inclusion, no demotion applied -- there is nothing to demote against once
 * everything is wanted). What changed is what `include_ops` defaults to NOT giving you: previously
 * omitting it meant "these rows literally cannot appear"; now it means "these rows are deprioritized
 * but still eligible to appear if nothing else scores as well" -- strictly MORE coverage than
 * before, never less, for every existing caller that never passed `include_ops` at all.
 *
 * ============================ THE EXHAUST LIST (confirmed from the schema + writers) ============
 *  - 'status'            CONFIRMED live in memory-exec today. skills/kb-memory/mem.mjs auto-shares
 *                         every `type==='status'` entry to the exec feed unconditionally (see
 *                         `if (share || type === "status") shared = await publishShared(...)`),
 *                         and semantic.mjs indexes every shared row verbatim into the `type` field
 *                         (Edm.String, filterable + facetable -- confirmed in both semantic.mjs and
 *                         skills/ring-memory-index/index-ring-memory.mjs's index schema).
 *  - 'compaction-digest'  CONFIRMED: skills/ledger-compaction/compact.mjs emits this as a rolled-up
 *  - 'compaction-note'    summary/annotation of OLDER status rows and superseded-chain bookkeeping
 *                         (`historyNote`, e.g. "X: superseded N earlier value(s) ... a -> b -> c") --
 *                         a byproduct of ledger maintenance, not a first-class assertion.
 *  - 'episode'            CONFIRMED live as of the Phase 2 capture plane (2026-07):
 *                         safety/journal.ts auto-journals every successful, mutating, non-dry-run
 *                         gateway tool call as an 'episode' Cosmos memory (write-through indexed
 *                         the same way every other memory_write is), and tools/memory/checkpoint.ts
 *                         writes one 'episode' marker per checkpoint() call. Both are exactly the
 *                         high-volume, low-signal operational exhaust this list exists to demote
 *                         from default knowledge queries -- they were originally listed here
 *                         defensively (see git history), before either producer existed.
 *  - 'heartbeat'          Named explicitly by the spec. NOTE: this is distinct from the agentstate
 *  - 'fleet-watch'        task-ledger's `task_heartbeat` tool (src/agentstate/ledger.ts) -- that is a
 *                         separate Cosmos work-queue, never indexed into memory-exec at all. These
 *  - 'digest'             two plus the generic 'digest' are included defensively (same reasoning as
 *                         'episode': no confirmed current producer, harmless no-op if absent, and a
 *                         fleet-watch/heartbeat/digest-style producer added later is demoted for
 *                         free instead of silently polluting the top of search).
 *
 * Tune the list in EXACTLY ONE place: EXHAUST_RECORD_TYPES below. Every caller (the opt-in
 * $filter-clause builder AND the default demotion path) reads it, so there is nothing else to keep
 * in sync.
 *
 * ============================ SCOPE ============================
 * This is a QUERY-side precision affordance only -- it never touches indexing, never deletes or
 * moves a document. A caller that wants the exhaust rows at FULL relevance rank (e.g. "what has the
 * CFO agent been doing lately") asks for that explicitly via the tool's `include_ops` param.
 */

/** The 4 durable knowledge types memory_remember accepts, for reference/documentation only -- this
 *  module does not gate on an allow-list, it demotes the (much shorter, easier to keep exhaustive)
 *  exhaust list instead, so an unanticipated new KNOWLEDGE type is never accidentally hidden. */
export const KNOWLEDGE_RECORD_TYPES = ['fact', 'decision', 'correction', 'pitfall'] as const;

/**
 * Operational exhaust: non-knowledge chatter that should not occupy the TOP of a default knowledge
 * query. See the file header for exactly which of these are confirmed-live vs included defensively.
 * TUNE HERE -- nothing else needs to change.
 */
export const EXHAUST_RECORD_TYPES: readonly string[] = [
  'status',
  'episode',
  'heartbeat',
  'fleet-watch',
  'digest',
  'compaction-digest',
  'compaction-note',
];

const EXHAUST_SET = new Set(EXHAUST_RECORD_TYPES);

/** True when `type` names one of the operational-exhaust record kinds. Pure. */
export function isExhaustType(type: unknown): boolean {
  return typeof type === 'string' && EXHAUST_SET.has(type);
}

/**
 * Build an Azure AI Search OData `$filter` clause that excludes every exhaust type on `field`
 * (default `type`), e.g. `type ne 'status' and type ne 'episode' and ...`. Pure string
 * construction -- cannot throw. Single-quotes in a type value are escaped per OData convention,
 * though every value in EXHAUST_RECORD_TYPES today is a plain lower-kebab slug.
 *
 * NOT applied automatically by default any more (see the 2026-07-21 CORRECTION above): a hard
 * server-side $filter can only ever exclude, never demote, so the default query path no longer
 * builds or sends this. It remains here as an OPT-IN helper for a caller that genuinely wants the
 * old strict-exclusion behavior -- pass its output as `HybridSearchOptions.filter` (azure/search.ts)
 * to hard-exclude exhaust rows from that call's candidate pool entirely, same as before.
 *
 * Callers that DO use it this way must still fail open if the resulting filter errors against a
 * given index (some rooms -- the doc-indexer profile rooms like commons-company-journal/
 * legal-company/finance-cfo-source-docs -- have no `type` field at all, so referencing it in
 * $filter returns 400). See src/azure/search.ts's hybridSearch, which retries filter-free on
 * exactly that failure regardless of which filter (this one, or any caller-supplied one) was sent.
 */
export function buildExhaustFilterClause(field = 'type'): string {
  return EXHAUST_RECORD_TYPES.map((t) => `${field} ne '${t.replace(/'/g, "''")}'`).join(' and ');
}

/**
 * DEMOTE (never delete): re-rank `hits` so that every exhaust-typed hit sorts AFTER every
 * non-exhaust hit, each group keeping its own relative (incoming) order, then optionally truncate
 * to `limit`. This is the query-time precision affordance every default `brain_search`/`kb_search`
 * call applies in place of the old hard exclude -- see the file header's 2026-07-21 CORRECTION.
 *
 * `includeOps === true` is a full-inclusion no-op: the input order is preserved exactly (there is
 * nothing to demote against once everything is wanted), only the `limit` truncation still applies
 * -- this is the unchanged "give me everything" contract `include_ops:true` always had.
 *
 * `includeOps === false` (the default) demotes: hits are partitioned into non-exhaust (kept in
 * place, in order) and exhaust (moved to the end, in order), concatenated, and truncated to `limit`
 * if given. Truncation happens AFTER the reorder, so exhaust hits can only ever fill slots left
 * over once every non-exhaust hit that fits has been placed -- they never crowd out a genuine hit,
 * but they are never permanently unreachable either: a room with nothing but exhaust still returns
 * exhaust rather than an empty result, and a room whose only strong match happens to be an
 * exhaust-typed row still surfaces it once genuine matches run out.
 *
 * Pure; never throws. Fast paths avoid allocation, mirroring filterRetracted's reference-equality
 * convention: an all-non-exhaust input (nothing to reorder) or an empty input returns the SAME
 * array reference, truncated only if `limit` actually cuts it down.
 */
export function demoteExhaustHits<T extends { type?: unknown }>(
  hits: readonly T[],
  includeOps: boolean,
  limit?: number,
): T[] {
  const arr = hits as T[];
  const capped = typeof limit === 'number' ? limit : undefined;

  if (includeOps) return capped === undefined ? arr : arr.slice(0, capped);
  if (!arr.length) return arr;

  let anyExhaust = false;
  for (const h of arr) {
    if (isExhaustType(h.type)) {
      anyExhaust = true;
      break;
    }
  }
  // Nothing to demote: preserve the fast, allocation-free no-op path.
  if (!anyExhaust) return capped === undefined ? arr : arr.slice(0, capped);

  const kept: T[] = [];
  const demoted: T[] = [];
  for (const h of arr) {
    if (isExhaustType(h.type)) demoted.push(h);
    else kept.push(h);
  }
  const merged = kept.concat(demoted);
  return capped === undefined ? merged : merged.slice(0, capped);
}
