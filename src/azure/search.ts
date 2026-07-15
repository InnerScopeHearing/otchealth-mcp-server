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
  /** Source path of the parent document (chunked doc rooms only), for citation. Flat rooms omit it. */
  path?: string;
}

/**
 * CHUNKED doc rooms (Phase-3 S1 integrated-vectorization). These indexes store one child doc per
 * CHUNK of a source document: the vector field is `text_vector` (not `contentVector`), and a query
 * returns many chunks of the same parent that must be deduped to one hit. EVERY OTHER room is FLAT
 * (one doc per record, `contentVector`) and keeps its exact prior behavior. This is the doc-room
 * registry (mirrors setup/expected-indexes.json's doc rooms); it ships AT the S1 cutover. Pre-cutover
 * (Basic, all flat) these rooms simply hit the chunk branch's fail-open and degrade to keyword — the
 * same degradation they already have under brain_search's default today, so deploying early is a no-op.
 */
const CHUNKED_ROOMS = new Set<string>([
  'commons-company-journal',
  'finance-cfo-source-docs',
  'legal-company',
  'legal-personal',
  'commerce-commerce-source-docs',
]);

/** Whether a room uses the chunked (text_vector, chunk->parent) schema. Pure. */
export function isChunkedRoom(index: string): boolean {
  return CHUNKED_ROOMS.has(index);
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

  const chunked = isChunkedRoom(index);
  const vecField = chunked ? 'text_vector' : 'contentVector';

  // Exhaust filtering is a MEMORY-room concern (only those rooms carry the `type` discriminator).
  // Chunked doc rooms have no `type` field, so attaching the filter there only ever 400s -> fail-open
  // to keyword-only, silently dropping vector+semantic recall. Skip the filter for chunked rooms.
  // (Pure string build — cannot throw. Flat rooms with no `type` field still 400 and fall through the
  // fail-open retry below to a filter-free query, exactly as before.)
  const filter = includeOps || chunked ? undefined : buildExhaustFilterClause('type');

  // Chunked rooms return N chunks per parent doc; over-fetch so post-dedup we can still surface `top`
  // distinct parents. Flat rooms fetch exactly `top` (unchanged).
  const fetchTop = chunked ? Math.min(50, top * 3) : top;

  const body: Record<string, unknown> = {
    search: query,
    top: fetchTop,
    queryType: 'semantic',
    semanticConfiguration: 'sem',
    searchMode: 'any',
  };
  if (vector) body.vectorQueries = [{ kind: 'vector', vector, fields: vecField, k: fetchTop }];
  if (filter) body.filter = filter;
  // Lean payload for chunked rooms: never return the 3072-float text_vector (retrievable by default
  // in the chunked index). Flat rooms keep the default projection (contentVector is retrievable:false).
  if (chunked) body.select = 'chunk_id,parent_id,title,path,chunk';

  // Bounded + one retry: search-by-POST is a read-only query, safe to repeat once on a
  // network blip / 429 / 5xx (see src/util/fetch-budget.ts).
  const doSearch = async (b: Record<string, unknown>) =>
    fetchWithBudget(`${ep}/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });

  const fallbackBody: Record<string, unknown> = { search: query, top: fetchTop, queryType: 'simple', searchMode: 'any' };
  if (chunked) fallbackBody.select = 'chunk_id,parent_id,title,path,chunk';

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
  const raw = (j.value || []).map((d) => ({
    score: (typeof d['@search.rerankerScore'] === 'number' ? d['@search.rerankerScore'] : d['@search.score']) as number | undefined,
    text: pickText(d).slice(0, 1200),
    id: d['id'] ?? d['chunk_id'] ?? d['key'] ?? '',
    type: typeof d['type'] === 'string' ? (d['type'] as string) : undefined,
    path: typeof d['path'] === 'string' ? (d['path'] as string) : undefined,
    // Dedup key for chunked rooms: the parent document. Flat rooms never dedup (each is its own key).
    _parent: String(d['parent_id'] ?? d['path'] ?? d['id'] ?? d['chunk_id'] ?? ''),
  }));

  let hits = raw;
  if (chunked) {
    // Collapse chunks to their parent: keep the single highest-scored chunk per parent and cite the
    // parent (id = parent key, path = source path). Stops one document from filling the result set
    // with N of its own chunks, and makes `count` mean "distinct documents", not "chunks".
    const best = new Map<string, (typeof raw)[number]>();
    for (const h of raw) {
      const cur = best.get(h._parent);
      if (!cur || (h.score ?? -Infinity) > (cur.score ?? -Infinity)) best.set(h._parent, h);
    }
    hits = [...best.values()]
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, top)
      .map((h) => ({ ...h, id: h._parent || h.id }));
  }

  // Strip the internal dedup key; the client-side exhaust backstop (belt + braces) still runs — a
  // no-op on chunked/typeless docs and byte-identical to before on flat memory rooms.
  let matches: KbHit[] = hits.map(({ _parent, ...h }) => h);
  matches = filterExhaustHits(matches, includeOps);
  return { matches, mode: vector ? 'hybrid+semantic' : 'keyword' };
}
