/**
 * Semantic recall over the `memory-exec` Azure AI Search index (the write-through-indexed
 * shared exec brain). Read-only. Ring-safe by construction — memory-exec only ever contains the
 * shared (non-PHI/non-MNPI/non-privileged) exec feed, the same surface the gateway already exposes
 * via the blob store.
 *
 * FIXED 2026-08-16 (the AWS-exit "memory_recall Azure bypass"): this file used to read
 * AZURE_SEARCH_ENDPOINT/AZURE_SEARCH_QUERY_KEY directly and fetchWithBudget() the Azure REST
 * surface inline, byte-identically regardless of SEARCH_BACKEND. That was invisible to both
 * dependency guards (they only scanned for an IMPORT of a concrete backend module; this file
 * imported neither azure/search.js nor search/opensearch.js, it just read env vars and rolled its
 * own fetch) — see src/search/azure-dependency-guard.test.ts's widened env-var-read scan. So
 * `memory_recall`'s SECOND-tier fallback (recall.ts tries agentic.ts's agentic-hybrid tier first,
 * this module second, keyword-over-blob last) would have kept calling a decommissioned Azure
 * endpoint after a SEARCH_BACKEND cutover, throwing/timing out on every call instead of answering
 * from whichever backend is actually active. (agentic.ts's agenticRecall — the FIRST-tier path —
 * had the identical defect and is fixed the same way, in the same change.)
 *
 * Now routes through the shared search dispatcher (src/search/index.ts), the exact seam every
 * other reader (kb_search, brain_search, kb_search_privileged, incident_match, deep-retrieval,
 * auto-supersede) already funnels through, so this honours SEARCH_BACKEND without a second
 * hand-rolled HTTP client. A welcome side effect: every query is now genuinely vector+semantic
 * hybrid (hybridSearch() calls embed() internally, honouring EMBEDDINGS_PROVIDER — see
 * azure/foundry.ts) rather than this file's previous queryType:'simple' keyword-only body, which
 * never sent a vector at all despite the module's name.
 *
 * KbHit (src/search/index.ts) is the dispatcher's deliberately room-agnostic hit shape and does
 * not carry memory-exec's own `ts`/`tags` fields (stripped for every room kind — see
 * azure/search.ts's runHybridSearch, "Strip the internal dedup + re-rank signal keys"). Rather
 * than pay for a second per-hit fetch just to backfill two cosmetic fields, SemanticHit reports
 * them as '' / [] here. `agent` IS recoverable losslessly without an extra round trip: the write
 * path encodes it as the `{agent}__{entryId}` doc-id prefix (azure/search-write.ts memoryDocId),
 * so this reuses agentFromDocId — the same parser auto-supersede-runtime.ts and incident-match.ts
 * already rely on for the identical recovery — instead of a third reimplementation.
 *
 * Inert unless the ACTIVE backend (SEARCH_BACKEND) is configured (callers fall back to keyword).
 */
import { hybridSearch, searchConfigured } from '../search/index.js';
import { agentFromDocId } from './auto-supersede-runtime.js';

const INDEX = 'memory-exec';

export interface SemanticHit {
  id: string;
  ts: string;
  type: string;
  text: string;
  tags: string[];
  agent: string;
  score: number;
}

/** True when the ACTIVE search backend (SEARCH_BACKEND: azure or opensearch) is reachable —
 *  mirrors the dispatcher's own config check rather than a hard-coded Azure-only one, so this no
 *  longer reports "unconfigured" the moment Azure's own vars go empty on cutover. */
export function semanticConfigured(): boolean {
  return searchConfigured();
}

/**
 * Search the shared brain by meaning. Returns up to `limit` hits, optionally filtered to one
 * agent lane (filtered CLIENT-SIDE, exactly as before this fix — the memory-exec `agent` field is
 * not guaranteed filterable server-side on every backend, and a rejected server-side filter fails
 * the WHOLE query open to an unfiltered, lower-quality keyword-only result on Azure, or is simply
 * dropped un-applied by the OpenSearch adapter's OData translator for a single `eq` clause — either
 * way, trusting a server-side filter here would silently widen the result set instead of narrowing
 * it. See auto-supersede-runtime.ts's own "never trust the $filter alone" note for the same
 * reasoning applied to a sibling caller.).
 * Returns null when not configured so the caller can fall back to keyword search.
 */
export async function semanticSearch(
  query: string,
  agent: string | null,
  limit: number,
): Promise<SemanticHit[] | null> {
  if (!searchConfigured()) return null;
  const top = agent ? Math.max(limit * 4, 40) : limit;
  const result = await hybridSearch(INDEX, query, top);
  if (!result) return null;
  let hits: SemanticHit[] = result.matches.map((h) => {
    const id = String(h.id ?? '');
    return {
      id,
      ts: '',
      type: h.type ?? '',
      text: h.text ?? '',
      tags: [],
      agent: agentFromDocId(id),
      score: h.score ?? 0,
    };
  });
  if (agent) hits = hits.filter((h) => h.agent === agent);
  return hits.slice(0, limit);
}
