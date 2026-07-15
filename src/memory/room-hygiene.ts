/**
 * ROOM HYGIENE — exclude OPERATIONAL EXHAUST from knowledge queries by default.
 *
 * ============================ THE PROBLEM ============================
 * The `memory-exec` index (and its per-ring siblings `finance-cfo-memory` / `legal-personal-memory`,
 * built by the same writer — see skills/ring-memory-index and skills/kb-memory/semantic.mjs in the
 * toolkit repo) carries EVERY row an agent's ledger publishes to the shared feed, not just durable
 * knowledge. In particular `type: 'status'` ("what I'm working on") is auto-shared on EVERY
 * `mem.mjs status` call — it is high-volume, low-signal chatter by design, not a fact/decision/
 * correction/pitfall. Left unfiltered, a `brain_search`/`kb_search` query gets diluted by this
 * operational exhaust: a real fact can rank behind a pile of "still working on X" status rows that
 * happen to share vocabulary with the query.
 *
 * KNOWLEDGE (never excluded, regardless of the list below) = the 4 durable types memory_remember
 * itself accepts for durable recall: fact, decision, correction, pitfall (see
 * src/tools/memory/remember.ts TYPES — note memory_remember also accepts 'status' at WRITE time;
 * this module governs READ-time precision, a different axis).
 *
 * ============================ THE EXHAUST LIST (confirmed from the schema + writers) ============
 *  - 'status'            CONFIRMED live in memory-exec today. skills/kb-memory/mem.mjs auto-shares
 *                         every `type==='status'` entry to the exec feed unconditionally (see
 *                         `if (share || type === "status") shared = await publishShared(...)`),
 *                         and semantic.mjs indexes every shared row verbatim into the `type` field
 *                         (Edm.String, filterable + facetable — confirmed in both semantic.mjs and
 *                         skills/ring-memory-index/index-ring-memory.mjs's index schema).
 *  - 'compaction-digest'  CONFIRMED: skills/ledger-compaction/compact.mjs emits this as a rolled-up
 *  - 'compaction-note'    summary/annotation of OLDER status rows and superseded-chain bookkeeping
 *                         (`historyNote`, e.g. "X: superseded N earlier value(s) ... a -> b -> c") —
 *                         a byproduct of ledger maintenance, not a first-class assertion.
 *  - 'episode'            Named explicitly by the room-hygiene spec (episodic/session-summary
 *                         records). No current writer emits this type; included defensively so a
 *                         future producer is excluded automatically with zero code change.
 *  - 'heartbeat'          Named explicitly by the spec. NOTE: this is distinct from the agentstate
 *  - 'fleet-watch'        task-ledger's `task_heartbeat` tool (src/agentstate/ledger.ts) — that is a
 *                         separate Cosmos work-queue, never indexed into memory-exec at all. These
 *  - 'digest'             two plus the generic 'digest' are included defensively (same reasoning as
 *                         'episode': no confirmed current producer, harmless no-op if absent, and a
 *                         fleet-watch/heartbeat/digest-style producer added later is excluded for
 *                         free instead of silently polluting search).
 *
 * Tune the list in EXACTLY ONE place: EXHAUST_RECORD_TYPES below. Every caller (the server-side
 * $filter clause AND the client-side post-filter backstop) reads it, so there is nothing else to
 * keep in sync.
 *
 * ============================ SCOPE ============================
 * This is a QUERY-side precision affordance only — it never touches indexing, never deletes or
 * moves a document. A caller that wants the excluded rows back (e.g. "what has the CFO agent been
 * doing lately") asks for them explicitly via the tool's `include_ops` param.
 */

/** The 4 durable knowledge types memory_remember accepts, for reference/documentation only — this
 *  module does not gate on an allow-list, it excludes the (much shorter, easier to keep exhaustive)
 *  exhaust list instead, so an unanticipated new KNOWLEDGE type is never accidentally hidden. */
export const KNOWLEDGE_RECORD_TYPES = ['fact', 'decision', 'correction', 'pitfall'] as const;

/**
 * Operational exhaust: non-knowledge chatter that should not surface in a default knowledge query.
 * See the file header for exactly which of these are confirmed-live vs included defensively.
 * TUNE HERE — nothing else needs to change.
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
 * construction — cannot throw. Single-quotes in a type value are escaped per OData convention,
 * though every value in EXHAUST_RECORD_TYPES today is a plain lower-kebab slug.
 *
 * Callers MUST fail open if the resulting filter errors against a given index (some rooms — the
 * doc-indexer profile rooms like commons-company-journal/legal-company/finance-cfo-source-docs —
 * have no `type` field at all, so referencing it in $filter returns 400. See src/azure/search.ts's
 * hybridSearch, which retries filter-free on exactly that failure).
 */
export function buildExhaustFilterClause(field = 'type'): string {
  return EXHAUST_RECORD_TYPES.map((t) => `${field} ne '${t.replace(/'/g, "''")}'`).join(' and ');
}

/**
 * Client-side post-filter backstop: drop hits whose `type` is operational exhaust, unless
 * `includeOps` is true. This runs REGARDLESS of whether the server-side $filter above was applied
 * (belt + braces): it is a no-op (returns the SAME array reference) whenever there is nothing to
 * drop, which covers both `includeOps === true` and rooms whose documents carry no `type` field at
 * all (e.g. the doc-indexer profile rooms) — those never match isExhaustType, so nothing is
 * removed. Pure; mirrors filterRetracted's reference-equality-when-empty convention (see
 * src/memory/retractions.ts) so a fully-open call is a true no-op with no extra allocation.
 */
export function filterExhaustHits<T extends { type?: unknown }>(hits: readonly T[], includeOps: boolean): T[] {
  const arr = hits as T[];
  if (includeOps) return arr;
  if (!arr.some((h) => isExhaustType(h.type))) return arr;
  return arr.filter((h) => !isExhaustType(h.type));
}
