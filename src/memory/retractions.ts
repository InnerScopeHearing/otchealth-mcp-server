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
import { queryDocs } from '../agentstate/cosmos.js';

const TTL_MS = 120_000;
let cache: { at: number; ids: Set<string> } | null = null;

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
 */
export async function retractedIds(): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.ids;

  const ids = new Set<string>();
  // Shared blob feed (where the ledger corrections live).
  try {
    for (const id of collectRetracted(await readSharedAll())) ids.add(id);
  } catch {
    /* fail-open */
  }
  // Cosmos memory-of-record (memory_write can declare supersedes since 2026-07-13).
  try {
    const rows = await queryDocs(
      'memory',
      "SELECT c.supersedes FROM c WHERE c.type = 'memory' AND IS_DEFINED(c.supersedes)",
      [],
      // Was {max:500}: at fleet scale that silently TRUNCATES the retracted set, re-opening the exact
      // rank-#1-retracted-belief bug this module exists to close (a superseded id past #500 would no
      // longer be filtered). Lift to 5000 (a projection of one tiny field over the supersedes-bearing
      // subset only, so it stays cheap). The query already selects just `supersedes`.
      { max: 5000 },
    );
    for (const id of collectRetracted(rows as Array<{ supersedes?: unknown }>)) ids.add(id);
  } catch {
    /* fail-open */
  }

  cache = { at: now, ids };
  return ids;
}

/** Test seam: drop the cache so one test never sees another test's retractions. */
export function __resetRetractionCache(): void {
  cache = null;
}
