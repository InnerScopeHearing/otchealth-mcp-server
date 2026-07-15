/**
 * Reciprocal Rank Fusion (RRF) — shared pure fusion utility.
 *
 * Extracted from tools/kb/brain-search.ts (Phase 4A, 2026-07-15) so both brain-search.ts AND
 * memory/deep-retrieval.ts can reuse the EXACT SAME fusion function without a tools -> memory ->
 * tools import cycle. Everywhere else in this repo, tools/ depends on memory/ + azure/, never the
 * reverse (e.g. tools/kb/brain-search.ts already imports memory/retractions.ts); deep-retrieval.ts
 * living in memory/ and needing rrfFuse would have broken that layering if it stayed in
 * tools/kb/brain-search.ts. brain-search.ts re-exports `rrfFuse`/`FusedHit` from here so its own
 * public surface (and the existing brain-search.test.ts import) is unchanged.
 *
 * Scores from different indexes/rooms (or, in deep mode, different sub-queries against the SAME
 * room) are on different, incomparable scales; RRF fuses by RANK (position), which is scale-free.
 * k=60 is the standard damping constant.
 */

export interface FusedHit {
  score: number;
  source: string;
  text: string;
  /** The index doc id (`{agent}__{entryId}`). Carried through so retracted beliefs can be identified. */
  id?: unknown;
  /** Source path of the parent doc (chunked doc rooms), threaded through for citation. */
  path?: string;
}

/**
 * Reciprocal Rank Fusion across ranked lists. Each entry in `perRoom` is one ranked list (its
 * `hits` array must already be in rank order, best first) tagged with a `room` label that is
 * carried onto every fused hit as `source`. The SAME room label may appear more than once (e.g.
 * deep-retrieval fusing one ranked list per sub-query for a given room) — each occurrence is just
 * another independent ranked list contributing its own rank-based scores; this function does not
 * dedupe by id, so a caller that wants one row per underlying document should dedupe the result
 * itself (see memory/deep-retrieval.ts's dedupeById for that case). Pure + unit-tested.
 */
export function rrfFuse(
  perRoom: Array<{ room: string; hits: Array<{ score?: number; text: string; id?: unknown; path?: string }> }>,
  top: number,
  k = 60,
): FusedHit[] {
  const fused: FusedHit[] = [];
  for (const { room, hits } of perRoom) {
    hits.forEach((h, i) => {
      fused.push({ score: 1 / (k + (i + 1)), source: room, text: h.text, id: h.id, path: h.path });
    });
  }
  return fused.sort((a, b) => b.score - a.score).slice(0, top);
}
