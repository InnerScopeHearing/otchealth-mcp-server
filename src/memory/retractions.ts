/**
 * RETRACTION FILTERING — a belief we have RETRACTED must not come back as a live truth.
 *
 * ============================ THE BUG THIS FIXES (found live, 2026-07-13) ============================
 * `supersedes` was only ever honoured in `wake` (and only on type==='correction'). Retrieval ignored
 * it completely. So the brain kept SERVING beliefs we had explicitly retracted -- and worse, it ranked
 * them ABOVE their own corrections.
 *
 * Live proof: brain_search("daily-digest root cause") returned
 *     rank #1  -> 20260713-015  "ROOT CAUSE = config drift"          <- WRONG. Retracted.
 *     rank #3  -> the correction, whose text literally says "This SUPERSEDES 20260713-015"
 * We were handing agents a known-false answer at the top of the results and burying the truth below it.
 * A ledger that cannot forget is not a memory -- it is a rumour mill.
 *
 * ============================ THE CONTRACT ============================
 * memory_remember/memory_write already document it: "readers DROP the superseded entry so a retracted
 * belief cannot resurface as a live truth." wake honoured that contract. Retrieval did not. Now it does.
 *
 * Retractions are collected from BOTH stores (the shared blob feed AND the Cosmos memory-of-record),
 * because since 2026-07-14 both can declare `supersedes` and both are write-through indexed into
 * memory-exec -- so a retraction recorded in either store must silence the belief from either store.
 *
 * Cached briefly: retractions are rare, searches are hot. FAIL-OPEN -- if we cannot load the retraction
 * set we return an EMPTY set and filter nothing, because degrading to "shows a stale belief" is far
 * better than degrading to "returns no results at all".
 */
import { readSharedAll } from './store.js';
import { queryDocs } from '../agentstate/store.js';

const TTL_MS = 120_000;
/**
 * How long a DEGRADED cache is trusted before we try again. Much shorter than TTL_MS: a degraded
 * cache is one built while a source was unreachable, so it is a stopgap, not an answer.
 */
const DEGRADED_RETRY_MS = 20_000;
let cache: {
  at: number;
  ids: Set<string>;
  byAgent: Map<string, Set<string>>;
  /** True when at least one source failed to load, so this cache may be MISSING retractions. */
  degraded: boolean;
} | null = null;

/** doc ids are `{agent}__{entryId}` (semantic.mjs docId). Recover the entry id. Pure. */
export function entryIdFromDocId(docId: unknown): string {
  const s = typeof docId === 'string' ? docId : '';
  const i = s.indexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}

/** Collect every id that some other entry claims to supersede. Pure + testable. */
export function collectRetracted(entries: Array<{ supersedes?: unknown }>): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const s = e?.supersedes;
    if (typeof s === 'string' && s.trim()) out.add(s.trim());
  }
  return out;
}

/**
 * Collect every id some entry claims to supersede, GROUPED by the SUPERSEDING entry's own `agent`
 * field. Pure + testable.
 *
 * WHY AGENT-SCOPED (review finding, 2026-07-30, from wake.ts/pack.ts's brief-mode PR): shared-feed
 * entry ids are per-agent day+counter values (memory/store.ts's nextId: `${day}-${N}` where N counts
 * only within THAT SAME agent's own rows), so two DIFFERENT agents' first entries on the same day
 * are both literally e.g. "20260730-001" -- a real collision, not a theoretical one. `retractedIds`
 * below returns a single FLEET-WIDE bare-id Set with no agent information, which is safe for its 3
 * existing callers (kb/openai-search.ts, kb/brain-search.ts, memory/deep-retrieval.ts x2): each
 * recovers a bare entry id from a `{agent}__{entryId}` SEARCH-INDEX doc id via entryIdFromDocId,
 * where the agent half is already known/checked separately by the caller's own room/lane scoping
 * before filterRetracted ever runs. wake.ts/pack.ts's brief mode is different: it applies retraction
 * directly against ONE agent's own in-memory entries by bare id, with no separate agent check, so a
 * bare fleet-wide Set is unsafe there -- an unrelated agent's retraction of "20260730-001" would
 * silently hide THIS agent's own unrelated live "20260730-001" entry. This function (and
 * retractedIdsForAgent below) exist to give wake.ts/pack.ts a properly agent-scoped lookup, without
 * changing retractedIds()'s existing bare-id contract or touching any of its 3 existing callers.
 */
export function collectRetractedByAgent(entries: Array<{ agent?: unknown; supersedes?: unknown }>): Map<string, Set<string>> {
  const byAgent = new Map<string, Set<string>>();
  for (const e of entries) {
    const agent = typeof e?.agent === 'string' ? e.agent : '';
    const s = e?.supersedes;
    if (!agent || typeof s !== 'string' || !s.trim()) continue;
    let set = byAgent.get(agent);
    if (!set) byAgent.set(agent, (set = new Set()));
    set.add(s.trim());
  }
  return byAgent;
}

/** Drop hits whose underlying entry has been retracted. Returns what survived + what was dropped. Pure. */
export function filterRetracted<T extends { id?: unknown }>(
  hits: T[],
  retracted: Set<string>,
): { kept: T[]; dropped: string[] } {
  if (retracted.size === 0) return { kept: hits, dropped: [] };
  const kept: T[] = [];
  const dropped: string[] = [];
  for (const h of hits) {
    const entryId = entryIdFromDocId(h.id);
    if (entryId && retracted.has(entryId)) dropped.push(entryId);
    else kept.push(h);
  }
  return { kept, dropped };
}

/**
 * The set of entry-ids that have been superseded, from BOTH memory stores.
 * FAIL-OPEN: on any error, returns an empty set (filter nothing) rather than breaking search.
 *
 * BARE, FLEET-WIDE ids -- see collectRetractedByAgent's header for why this is unsafe to apply
 * directly against a single agent's own payload (a cross-agent id collision), and use
 * retractedIdsForAgent instead for that use case. This function's existing bare-id contract and its
 * 3 existing callers are unchanged.
 */
export async function retractedIds(): Promise<Set<string>> {
  await refreshCache();
  return cache?.ids ?? new Set();
}

/**
 * Agent-scoped retraction lookup: only the ids THIS agent's own entries (shared feed or Cosmos)
 * declared superseded. Safe to apply directly against a single agent's own payload, unlike
 * retractedIds()'s bare fleet-wide set (see collectRetractedByAgent's header). Shares
 * retractedIds()'s cache/fetch -- calling both within the TTL window costs one fetch, not two.
 * FAIL-OPEN: an unknown agent, or any fetch failure, returns an empty set.
 */
export async function retractedIdsForAgent(agent: string): Promise<Set<string>> {
  await refreshCache();
  return cache?.byAgent.get(agent) ?? new Set();
}

/** Shared cache-fill for retractedIds/retractedIdsForAgent -- one fetch of both stores serves both
 * the bare fleet-wide Set and the per-agent grouping. FAIL-OPEN throughout: a failed fetch leaves
 * whatever was already collected (possibly nothing) rather than throwing. */
async function refreshCache(): Promise<void> {
  const now = Date.now();
  // A degraded cache expires far sooner: it was built while a source was down and may be missing
  // retractions, so we retry rather than trusting it for the full TTL.
  if (cache && now - cache.at < (cache.degraded ? DEGRADED_RETRY_MS : TTL_MS)) return;

  const ids = new Set<string>();
  const byAgent = new Map<string, Set<string>>();
  const merge = (m: Map<string, Set<string>>) => {
    for (const [agent, set] of m) {
      let existing = byAgent.get(agent);
      if (!existing) byAgent.set(agent, (existing = new Set()));
      for (const id of set) existing.add(id);
    }
  };
  // Shared blob feed (where the ledger corrections live). Each MemoryEntry already carries `agent`.
  // Track per-source success. Fail-open on the FETCH is correct (a retraction lookup must never
  // block a search), but caching the RESULT of a failure as authoritative is not: an empty
  // retraction set means "nothing has been retracted", which is the strongest possible claim this
  // module can make, and it would be made on the basis of a network error. See the cache write below.
  let degraded = false;
  try {
    const rows = await readSharedAll();
    for (const id of collectRetracted(rows)) ids.add(id);
    merge(collectRetractedByAgent(rows));
  } catch {
    degraded = true;
  }
  // Cosmos memory-of-record (memory_write can declare supersedes since 2026-07-13).
  try {
    const rows = await queryDocs(
      'memory',
      "SELECT c.agent, c.supersedes FROM c WHERE c.type = 'memory' AND IS_DEFINED(c.supersedes)",
      [],
      // Was {max:500}: at fleet scale that silently TRUNCATES the retracted set, re-opening the exact
      // rank-#1-retracted-belief bug this module exists to close (a superseded id past #500 would no
      // longer be filtered). Lift to 5000 (a projection of two tiny fields over the supersedes-bearing
      // subset only, so it stays cheap). `agent` was added to the projection alongside `supersedes`
      // (review finding, 2026-07-30) so the by-agent grouping below can be built from the SAME query
      // rather than a second one.
      { max: 5000 },
    );
    const typed = rows as Array<{ agent?: unknown; supersedes?: unknown }>;
    for (const id of collectRetracted(typed)) ids.add(id);
    merge(collectRetractedByAgent(typed));
  } catch {
    degraded = true;
  }

  // NEVER let a failed load DROP a retraction we already knew about.
  //
  // Before this, a transient failure on either source still installed the resulting (empty or
  // partial) set as the authoritative cache for the full TTL. "Nothing has been retracted" is the
  // strongest claim this module can make, and it was being made on the strength of a network error
  // -- during which a belief the fleet had explicitly corrected would sail back through
  // brain_search's fast path as current truth, with no retracted_dropped disclosure, because that
  // filter had simply been emptied. That is the precise "rumour mill" failure this module exists to
  // prevent, so the union below is a correctness requirement, not an optimisation.
  //
  // Union, never replace: anything newly learned is added, and everything previously known is kept.
  // Over-retracting (holding a stale retraction slightly too long) merely hides a belief;
  // under-retracting resurfaces a known-false one. The asymmetry is deliberate.
  if (degraded && cache) {
    for (const id of cache.ids) ids.add(id);
    merge(cache.byAgent);
  }
  cache = { at: now, ids, byAgent, degraded };
}

/** Test seam: drop the cache so one test never sees another test's retractions. */
export function __resetRetractionCache(): void {
  cache = null;
}
