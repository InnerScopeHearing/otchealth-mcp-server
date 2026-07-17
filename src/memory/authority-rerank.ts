/**
 * Authority + freshness RE-RANK for MEMORY-room recall (Wave 1, 2026-07-17).
 *
 * WHY (the CORRECTION-plague + the rank-#1-retracted-belief bug): hybridSearch ranks purely on
 * `@search.rerankerScore` / vector score, then sorts descending (azure/search.ts). Relevance is the
 * ONLY signal. So a stale, low-authority auto-journal *episode* can outrank the current *decision* or
 * *correction* that supersedes it whenever their raw relevance is close. Every documented recall
 * failure in the ledger is this class: the CFO 0-hit, the retracted belief served at #1, the
 * pervasive "CORRECTION to earlier note" entries that never win the top slot.
 *
 * WHY NOT an Azure scoringProfile (the Magic-Bottle research's first suggestion): scoringProfiles
 * only weight the BM25 `@search.score`. Our query is `queryType:'semantic'` + vector, so the final
 * order is the reranker/vector score — a scoringProfile would be INERT on the hot path. The correct
 * fix is a deterministic post-retrieval re-rank that works regardless of the base score's origin.
 *
 * WHAT: multiply the base relevance by three bounded, conservative factors and re-sort:
 *   - AUTHORITY by entry type:   decision/correction > pitfall > fact > status > episode/heartbeat.
 *   - SOURCE authority:          Matt/human > exec lane (cto/cfo/...) > automated capture (auto-journal).
 *   - FRESHNESS:                 a gentle recency boost with a 45-day half-life.
 * The factors are deliberately near 1.0 so they BREAK TIES and demote stale/retracted episodes, but a
 * strongly-more-relevant hit (large base-score gap) still wins — relevance stays dominant, authority
 * arbitrates near-ties. Fail-open: any missing field contributes a 1.0 multiplier (no change). Pure
 * and side-effect-free; `MEMORY_RERANK_MODE=off` makes it byte-identical to the old order.
 */

export interface Rerankable {
  score?: number;
  type?: string;
  ts?: string;
  source?: string;
  by?: string;
}

/** Kill-switch. Default ON. Anything other than 'off' (case-insensitive) leaves it enabled. */
export function rerankEnabled(mode: string | undefined): boolean {
  return (mode ?? 'on').trim().toLowerCase() !== 'off';
}

/** Entry-type authority: a decision/correction is worth more than an episode of equal relevance.
 *  Unknown/absent type -> 1.0 (neutral). Kept modest so relevance still dominates. */
export function authorityMultiplier(type: string | undefined): number {
  switch ((type ?? '').trim().toLowerCase()) {
    case 'decision':
    case 'correction':
      return 1.5;
    case 'pitfall':
      return 1.4;
    case 'fact':
      return 1.2;
    case 'status':
      return 0.85;
    case 'episode':
      return 0.7;
    case 'heartbeat':
    case 'digest':
      return 0.6;
    default:
      return 1.0;
  }
}

const EXEC_BY = new Set(['cto', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'matt']);

/** Source authority: a fact Matt (or an exec) asserted outranks automated capture of equal relevance.
 *  Reads both `source` (free text, e.g. "Matt 2026-06-20") and `by` (the writer lane). Neutral 1.0
 *  when nothing matches. Automated capture (auto-journal / hook / reflect) is gently demoted. */
export function sourceMultiplier(source: string | undefined, by: string | undefined): number {
  const s = (source ?? '').toLowerCase();
  const b = (by ?? '').trim().toLowerCase();
  if (/\bmatt\b/.test(s) || b === 'matt') return 1.3;
  // Automated capture channels: demote below a deliberate human/agent assertion.
  if (/auto-journal|autojournal|hook|reflect\.mjs|precompact|session-?end/.test(s)) return 0.9;
  if (EXEC_BY.has(b)) return 1.1;
  return 1.0;
}

/** Freshness: 1 + 0.4 * exp(-ageDays / 45). Bounded [1.0, 1.4]. A brand-new entry gets ~1.4x, ~30 days
 *  ~1.2x, and old entries settle to 1.0 (never a penalty — old-but-relevant is not demoted, recent is
 *  only lifted). Missing/unparseable ts -> 1.0. */
export function freshnessMultiplier(ts: string | undefined, nowMs: number): number {
  if (!ts) return 1.0;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return 1.0;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return 1 + 0.4 * Math.exp(-ageDays / 45);
}

/** The composite adjusted score used for re-ranking. Pure. */
export function adjustedScore(hit: Rerankable, nowMs: number): number {
  const base = typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : 0;
  return base * authorityMultiplier(hit.type) * sourceMultiplier(hit.source, hit.by) * freshnessMultiplier(hit.ts, nowMs);
}

/**
 * Re-rank a list of memory hits by adjusted score, descending, STABLY (ties keep their incoming
 * order, so equal-authority equal-freshness hits preserve the search engine's relevance order).
 * Returns a NEW array; never mutates the input. No-op (returns the input order) when disabled.
 */
export function rerankByAuthority<T extends Rerankable>(hits: T[], opts?: { mode?: string; nowMs?: number }): T[] {
  if (!rerankEnabled(opts?.mode)) return hits;
  const nowMs = opts?.nowMs ?? Date.now();
  return hits
    .map((h, i) => ({ h, i, adj: adjustedScore(h, nowMs) }))
    .sort((a, b) => b.adj - a.adj || a.i - b.i)
    .map((x) => x.h);
}
