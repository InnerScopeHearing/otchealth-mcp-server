/**
 * Shared hybrid retrieval over Azure AI Search (otchealth-dataroom-search).
 * Hybrid = BM25 keyword (search) + vector (contentVector via text-embedding-3-large) + 'sem'
 * semantic ranker, with graceful degradation to keyword-only on 400 / missing embeddings.
 * Read-only: uses AZURE_SEARCH_QUERY_KEY.
 *
 * ROOM HYGIENE (default): operational exhaust (status/episode/heartbeat/digest-style chatter —
 * see src/memory/room-hygiene.ts) is excluded from every call unless the caller opts in via
 * `opts.includeOps`. Applied server-side via an OData $filter on `type` where the index has that
 * field (memory-exec, finance-cfo-memory, legal-personal-memory); rooms with no `type` field
 * (the doc-indexer profile rooms) 400 on the filter and fall open to a filter-free query, which
 * is correct there since those rooms never carried this vocabulary in the first place. A
 * client-side post-filter backstop runs unconditionally as belt + braces. `opts` defaults to
 * "no filtering" (the pre-existing, unchanged behavior) when omitted entirely, so any existing
 * caller that does not pass it (e.g. kb_search_privileged) is byte-for-byte unaffected; the tool
 * layer (brain_search, kb_search) is what makes exclusion the default by always passing opts.
 */
import { loadEnv } from '../config/env.js';
import { embed } from './foundry.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { buildExhaustFilterClause, filterExhaustHits } from '../memory/room-hygiene.js';

const API_VERSION = '2023-11-01';

export interface KbHit {
  score: number | undefined;
  text: string;
  id: unknown;
  /** The record's discriminator (fact/decision/.../status/...), when the index carries one. */
  type?: string;
}

export interface HybridSearchOptions {
  /** Include operational exhaust (status/episode/heartbeat/digest chatter). Default: unchanged
   *  (no filtering) when `opts` itself is omitted — see the file header. */
  includeOps?: boolean;
}

function pickText(doc: Record<string, unknown>): string {
  for (const f of ['text', 'content', 'chunk', 'body', 'pageContent']) {
    if (typeof doc[f] === 'string' && (doc[f] as string).length) return doc[f] as string;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('@') || /vector/i.test(k)) continue;
    if (typeof v === 'string' && v.length > 40) return v;
  }
  return '';
}

export function searchConfigured(): boolean {
  const e = loadEnv();
  return Boolean(e.AZURE_SEARCH_ENDPOINT && e.AZURE_SEARCH_QUERY_KEY);
}

export async function hybridSearch(
  index: string,
  query: string,
  top: number,
  opts?: HybridSearchOptions,
): Promise<{ matches: KbHit[]; mode: string } | null> {
  const e = loadEnv();
  const ep = (e.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
  const key = e.AZURE_SEARCH_QUERY_KEY || '';
  if (!ep || !key) return null;

  // Library default is "no filtering" when opts is omitted entirely, so pre-existing callers
  // (kb_search_privileged) are unaffected. Callers that want ROOM HYGIENE (brain_search,
  // kb_search) pass opts explicitly with includeOps defaulted to false at the tool layer.
  const includeOps = opts?.includeOps ?? true;

  let vector: number[] | null = null;
  try {
    vector = await embed(query);
  } catch {
    vector = null;
  }

  // Pure string build — cannot throw. Rooms whose schema has no `type` field will 400 on this
  // filter; the fail-open retry below drops it and falls through to a filter-free query.
  const filter = includeOps ? undefined : buildExhaustFilterClause('type');

  const body: Record<string, unknown> = {
    search: query,
    top,
    queryType: 'semantic',
    semanticConfiguration: 'sem',
    searchMode: 'any',
  };
  if (vector) body.vectorQueries = [{ kind: 'vector', vector, fields: 'contentVector', k: top }];
  if (filter) body.filter = filter;

  // Bounded + one retry: search-by-POST is a read-only query, safe to repeat once on a
  // network blip / 429 / 5xx (see src/util/fetch-budget.ts).
  const doSearch = async (b: Record<string, unknown>) =>
    fetchWithBudget(`${ep}/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });

  const fallbackBody: Record<string, unknown> = { search: query, top, queryType: 'simple', searchMode: 'any' };

  // FAIL-OPEN: a filter/semantic-ranker problem must never take a room down. A 400 (semantic
  // ranker unsupported on this SKU, OR — when a type-exclusion filter is attached — a room whose
  // schema has no filterable `type` field) falls through to the plain, filter-free query. A
  // THROWN error on the filtered attempt (e.g. a network blip coinciding with the extra filter
  // clause) gets the same one-shot fallback rather than propagating a filter-construction problem
  // as a search outage.
  let r: Response;
  try {
    r = await doSearch(body);
    if (r.status === 400) {
      r = await doSearch(fallbackBody);
    }
  } catch {
    r = await doSearch(fallbackBody);
  }
  if (!r.ok) throw new Error(`search ${r.status}`);
  const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
  let matches: KbHit[] = (j.value || []).map((d) => ({
    score: (typeof d['@search.rerankerScore'] === 'number' ? d['@search.rerankerScore'] : d['@search.score']) as number | undefined,
    text: pickText(d).slice(0, 1200),
    id: d['id'] ?? d['chunk_id'] ?? d['key'] ?? '',
    type: typeof d['type'] === 'string' ? (d['type'] as string) : undefined,
  }));
  // Client-side post-filter backstop (belt + braces): covers the case where the server-side
  // filter was dropped by the fail-open fallback above. No-op on rooms whose docs carry no
  // `type` field, and a true no-op (same array reference) when includeOps is true.
  matches = filterExhaustHits(matches, includeOps);
  return { matches, mode: vector ? 'hybrid+semantic' : 'keyword' };
}
