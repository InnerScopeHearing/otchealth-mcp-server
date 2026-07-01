/**
 * Agentic hybrid recall over the `memory-exec` Azure AI Search index.
 *
 * Upgrades flat semantic search to: query-planning → parallel hybrid search → RRF fusion.
 * Drop-in compatible with the mode/results shape that recall.ts already consumes.
 *
 * Required env vars (read directly from process.env — no new vars beyond the existing pair):
 *   AZURE_SEARCH_ENDPOINT   – e.g. https://my-search.search.windows.net
 *   AZURE_SEARCH_QUERY_KEY  – read-only query key (same as semantic.ts)
 *
 * NOTE: memory-exec uses simple keyword search today (queryType:'simple', no vector field
 * or semantic configuration referenced in semantic.ts). This module therefore makes the
 * query HYBRID by sending both the BM25 'search' field AND requesting queryType:'semantic'
 * with the default semantic configuration 'default'. If a semantic config named differently
 * is later added, update SEMANTIC_CONFIG below.
 */

import { embed, embedBatch } from '../azure/foundry.js';

const INDEX = 'memory-exec';
const API_VERSION = '2023-11-01';
// VERIFIED against the live index (otchealth-dataroom-search, 2026-06-26): semantic config is
// named 'sem' and the vector field is 'contentVector' (text-embedding-3-large). Earlier 'default'
// was wrong and silently degraded every query to keyword.
const SEMANTIC_CONFIG = 'sem';
const VECTOR_FIELD = 'contentVector';
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

// ── Config ───────────────────────────────────────────────────────────────────

function cfg(): { ep: string; key: string } | null {
  const ep = (process.env['AZURE_SEARCH_ENDPOINT'] ?? '').replace(/\/$/, '');
  const key = process.env['AZURE_SEARCH_QUERY_KEY'] ?? '';
  return ep && key ? { ep, key } : null;
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

// ── Single hybrid search ──────────────────────────────────────────────────────

interface RawHit {
  id: string;
  ts: string;
  type: string;
  text: string;
  tags: string[];
  agent: string;
  score: number;
}

async function hybridSearch(
  subQuery: string,
  top: number,
  c: { ep: string; key: string },
  precomputedVector?: number[] | null,
): Promise<RawHit[]> {
  // TRUE HYBRID: BM25 keyword (search) + vector (contentVector) + 'sem' semantic ranker.
  // The caller (agenticRecall) embeds every sub-query in ONE batched Foundry call up front and
  // passes the matching vector in as `precomputedVector`. If that batch call was skipped or
  // failed for this sub-query (precomputedVector === undefined), fall back to embedding it here
  // individually, the exact same per-call embed()->null try/catch this function always had, so
  // a broken/partial batch degrades to the pre-batching behavior rather than losing vector search
  // entirely. `null` (as opposed to undefined) means the batch ran and explicitly produced no
  // vector for this query; that is honored as keyword+semantic-only, no per-call embed retry.
  let vector: number[] | null;
  if (precomputedVector !== undefined) {
    vector = precomputedVector;
  } else {
    try {
      vector = await embed(subQuery);
    } catch {
      vector = null;
    }
  }

  const body: Record<string, unknown> = {
    search: subQuery,
    top,
    queryType: 'semantic',
    semanticConfiguration: SEMANTIC_CONFIG,
    searchMode: 'any',
  };
  if (vector) {
    body.vectorQueries = [
      { kind: 'vector', vector, fields: VECTOR_FIELD, k: top },
    ];
  }

  const r = await fetch(
    `${c.ep}/indexes/${INDEX}/docs/search?api-version=${API_VERSION}`,
    {
      method: 'POST',
      headers: { 'api-key': c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );

  // Gracefully degrade if semantic ranker not provisioned on this SKU
  if (r.status === 400) {
    const fallbackBody: Record<string, unknown> = {
      search: subQuery,
      top,
      queryType: 'simple',
      searchMode: 'any',
    };
    const r2 = await fetch(
      `${c.ep}/indexes/${INDEX}/docs/search?api-version=${API_VERSION}`,
      {
        method: 'POST',
        headers: { 'api-key': c.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(fallbackBody),
      },
    );
    if (!r2.ok) throw new Error(`memory-exec agentic search ${r2.status}`);
    const j2 = (await r2.json()) as { value?: Array<Record<string, unknown>> };
    return mapHits(j2.value ?? []);
  }

  if (!r.ok) throw new Error(`memory-exec agentic search ${r.status}`);
  const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
  return mapHits(j.value ?? []);
}

function mapHits(raw: Array<Record<string, unknown>>): RawHit[] {
  return raw.map((h) => ({
    id: String(h['id'] ?? ''),
    ts: String(h['ts'] ?? ''),
    type: String(h['type'] ?? ''),
    text: String(h['text'] ?? ''),
    tags: Array.isArray(h['tags']) ? (h['tags'] as string[]) : [],
    agent: String(h['agent'] ?? ''),
    score:
      typeof h['@search.rerankerScore'] === 'number'
        ? (h['@search.rerankerScore'] as number)
        : typeof h['@search.score'] === 'number'
          ? (h['@search.score'] as number)
          : 0,
  }));
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
 * Decomposes the query, fans out hybrid searches concurrently, fuses results with RRF.
 * Returns { mode: 'unconfigured', subQueries, results: [] } when env vars are absent
 * so recall.ts can fall through to keyword search — mirrors semantic.ts behaviour exactly.
 */
export async function agenticRecall(
  query: string,
  opts?: { agent?: string; top?: number },
): Promise<AgenticRecallResult> {
  const subQueries = planSubQueries(query);
  const c = cfg();

  if (!c) {
    return { mode: 'unconfigured', subQueries, results: [] };
  }

  const perQueryTop = opts?.top ?? DEFAULT_TOP;
  const agentFilter = opts?.agent ?? null;

  // Embed every sub-query in ONE batched Foundry call instead of one embed() call per sub-query
  // (previously 2-4 separate round trips inside the Promise.allSettled fan-out below). A failed
  // or unconfigured batch is not fatal: `batchVectors` stays null and each hybridSearch() call
  // transparently falls back to its own per-item embed(), exactly as before batching existed.
  let batchVectors: number[][] | null = null;
  try {
    batchVectors = await embedBatch(subQueries);
  } catch {
    batchVectors = null;
  }

  // Fan out all sub-query searches concurrently, each with its precomputed vector (or undefined
  // to trigger hybridSearch's own per-item embed() fallback when the batch didn't produce one).
  const settled = await Promise.allSettled(
    subQueries.map((sq, i) => hybridSearch(sq, perQueryTop, c, batchVectors?.[i])),
  );

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
