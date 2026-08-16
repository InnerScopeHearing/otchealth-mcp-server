/**
 * Agentic hybrid recall over the `memory-exec` Azure AI Search index.
 *
 * Upgrades flat semantic search to: query-planning → parallel hybrid search → RRF fusion.
 * Drop-in compatible with the mode/results shape that recall.ts already consumes. This is
 * `memory_recall`'s FIRST-tier path (recall.ts tries this — via hot-cache.ts's cachedAgenticRecall
 * wrapper — before falling back to ./semantic.ts, then to keyword-over-blob).
 *
 * FIXED 2026-08-16 (the AWS-exit "memory_recall Azure bypass"): this file used to read
 * `process.env['AZURE_SEARCH_ENDPOINT']`/`process.env['AZURE_SEARCH_QUERY_KEY']` directly (not
 * even via config/env.ts's loadEnv()) and issue its own bare `fetch()` calls — no timeout, no
 * retry, and completely invisible to both dependency guards, since neither an env-var read nor a
 * hand-rolled fetch is an IMPORT of a concrete backend module (see
 * src/search/azure-dependency-guard.test.ts's widened env-var-read scan, which is what actually
 * catches this class now). Being memory_recall's HIGHEST-PRIORITY tier, this was the more severe
 * of the two Azure-bypass instances: every recall would try this path FIRST regardless of
 * SEARCH_BACKEND, and only fall through to ./semantic.ts (the second tier, fixed in the same
 * change) once every sub-query's request against a decommissioned Azure endpoint had actually
 * failed.
 *
 * Now routes each sub-query through the shared search dispatcher (src/search/index.ts) — the same
 * seam every other reader funnels through — so this honours SEARCH_BACKEND and picks up
 * fetchWithBudget's bounded timeout/retry for free. TRADEOFF, explicitly accepted: the dispatcher's
 * hybridSearch() always embeds its own query text internally (honouring EMBEDDINGS_PROVIDER — see
 * azure/foundry.ts) and has no parameter to accept a precomputed vector, so the single-batched-
 * embedBatch()-call optimization this file used to do across all of a query's sub-queries is gone;
 * each sub-query now costs its own embed() call (bounded at 4 sub-queries by planSubQueries' cap).
 * That is a small, bounded latency cost, not a correctness change — the alternative (keeping the
 * hand-rolled per-vector fetch client just to preserve the batching) is exactly the shape of bypass
 * this fix exists to close.
 *
 * KbHit (src/search/index.ts) is the dispatcher's deliberately room-agnostic hit shape and does
 * not carry memory-exec's own `ts`/`tags` fields (stripped for every room kind — see
 * azure/search.ts's runHybridSearch). RawHit reports them as '' / [] here rather than paying for a
 * second per-hit fetch. `agent` IS recoverable losslessly: the write path encodes it as the
 * `{agent}__{entryId}` doc-id prefix (azure/search-write.ts memoryDocId), so this reuses
 * agentFromDocId — the same parser ./semantic.ts (fixed alongside this file), auto-supersede-
 * runtime.ts, and incident-match.ts all rely on for the identical recovery.
 */

import { hybridSearch as dispatcherHybridSearch, searchConfigured } from '../search/index.js';
import { agentFromDocId } from './auto-supersede-runtime.js';

const INDEX = 'memory-exec';
const RRF_K = 60;
const DEFAULT_TOP = 5;
const FUSION_TOP = 8;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgenticHit {
  id: string;
  ts: string;
  type: string;
  text: string;
  tags: string[];
  agent: string;
  score: number;        // RRF-fused score
  sourceSubQuery: string;
}

export interface AgenticRecallResult {
  mode: 'agentic-hybrid' | 'unconfigured';
  subQueries: string[];
  results: AgenticHit[];
}

// ── Query planning (heuristic, no LLM) ───────────────────────────────────────

/**
 * Decompose a user query into 2–4 focused sub-queries using lightweight heuristics.
 * Always includes the original query. De-duplicated, capped at 4.
 */
function planSubQueries(query: string): string[] {
  const q = query.trim();
  const candidates: string[] = [q];

  // Split on 'and', 'vs', 'versus', commas, semicolons, '?'
  const splitPattern = /\s+(?:and|vs\.?|versus)\s+|[,;]|\?(?=\s|$)/gi;
  const parts = q
    .split(splitPattern)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);

  for (const part of parts) {
    if (part.toLowerCase() !== q.toLowerCase()) {
      candidates.push(part);
    }
  }

  // Deduplicate case-insensitively, preserving first occurrence
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }

  return deduped.slice(0, 4);
}

// ── Single hybrid search (via the shared dispatcher) ──────────────────────────

interface RawHit {
  id: string;
  ts: string;
  type: string;
  text: string;
  tags: string[];
  agent: string;
  score: number;
}

/**
 * One sub-query's hybrid search, via src/search/index.ts's dispatcher — SEARCH_BACKEND-aware,
 * bounded (fetchWithBudget), and fail-open the same way every other dispatcher caller already is:
 * a thrown error here is left to propagate to the caller's own Promise.allSettled, which drops
 * just this one sub-query rather than the whole recall (see agenticRecall below).
 */
async function subQuerySearch(subQuery: string, top: number): Promise<RawHit[]> {
  const result = await dispatcherHybridSearch(INDEX, subQuery, top);
  if (!result) return [];
  return result.matches.map((h) => {
    const id = String(h.id ?? '');
    return {
      id,
      ts: '',
      type: h.type ?? '',
      text: h.text ?? '',
      tags: [] as string[],
      agent: agentFromDocId(id),
      score: h.score ?? 0,
    };
  });
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────────────────

function rrfFuse(
  rankedLists: Array<{ subQuery: string; hits: RawHit[] }>,
): AgenticHit[] {
  // Accumulate RRF scores: score(d) = Σ 1/(k + rank)
  const scoreMap = new Map<string, { hit: RawHit; rrfScore: number; sourceSubQuery: string }>();

  for (const { subQuery, hits } of rankedLists) {
    hits.forEach((hit, zeroIdx) => {
      const rank = zeroIdx + 1;
      const contrib = 1 / (RRF_K + rank);
      const existing = scoreMap.get(hit.id);
      if (existing) {
        existing.rrfScore += contrib;
        // Keep the sub-query label of the highest-contributing list (first seen wins)
      } else {
        scoreMap.set(hit.id, { hit, rrfScore: contrib, sourceSubQuery: subQuery });
      }
    });
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, FUSION_TOP)
    .map(({ hit, rrfScore, sourceSubQuery }) => ({
      ...hit,
      score: rrfScore,
      sourceSubQuery,
    }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * agenticRecall: hybrid + agentic memory retrieval over memory-exec.
 *
 * Decomposes the query, fans out hybrid searches concurrently (through the shared dispatcher,
 * so SEARCH_BACKEND is honoured), fuses results with RRF.
 * Returns { mode: 'unconfigured', subQueries, results: [] } when no search backend is reachable
 * so recall.ts can fall through to flat semantic, then keyword search.
 */
export async function agenticRecall(
  query: string,
  opts?: { agent?: string; top?: number },
): Promise<AgenticRecallResult> {
  const subQueries = planSubQueries(query);

  if (!searchConfigured()) {
    return { mode: 'unconfigured', subQueries, results: [] };
  }

  const perQueryTop = opts?.top ?? DEFAULT_TOP;
  const agentFilter = opts?.agent ?? null;

  // Fan out all sub-query searches concurrently. Each independently embeds + hybrid-searches
  // through the dispatcher; a failure in one sub-query (network blip that outlasts
  // fetchWithBudget's own retry, a genuinely unreachable backend, ...) is caught by allSettled
  // below and silently dropped rather than failing the whole recall.
  const settled = await Promise.allSettled(subQueries.map((sq) => subQuerySearch(sq, perQueryTop)));

  const rankedLists: Array<{ subQuery: string; hits: RawHit[] }> = [];
  for (let i = 0; i < subQueries.length; i++) {
    const result = settled[i];
    if (result && result.status === 'fulfilled') {
      rankedLists.push({ subQuery: subQueries[i]!, hits: result.value });
    }
    // Silently drop failed sub-queries — partial results are better than a full throw
  }

  let fused = rrfFuse(rankedLists);

  // Client-side agent filter (mirrors semantic.ts approach — field not guaranteed filterable)
  if (agentFilter) {
    fused = fused.filter((h) => h.agent === agentFilter);
  }

  return { mode: 'agentic-hybrid', subQueries, results: fused };
}
