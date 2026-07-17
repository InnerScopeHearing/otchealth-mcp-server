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
import { rerankByAuthority } from '../memory/authority-rerank.js';

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
  /**
   * Raw OData $filter override, e.g. "type eq 'pitfall' or type eq 'correction'". When set, this
   * REPLACES the room-hygiene exhaust filter entirely (`includeOps` is ignored) -- the caller is
   * asking for a specific, precise slice of the room (e.g. incident-match's pitfall/correction-only
   * recall query), not "every knowledge type except operational exhaust". Still governed by the
   * SAME fail-open retry as the exhaust filter below: a 400 caused by this filter (e.g. queried
   * against a room with no `type` field at all) falls back to a plain, filter-free keyword query
   * exactly like every other filter path here. Ignored for chunked doc rooms (no `type` field;
   * same reasoning as the exhaust filter skip below).
   */
  filter?: string;
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
  // opts.filter (when present) takes precedence over the exhaust clause -- see HybridSearchOptions.
  const filter = chunked ? undefined : opts?.filter ?? (includeOps ? undefined : buildExhaustFilterClause('type'));

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

  // The keyword fail-open fallback carries NO select and no vector: if the primary 400 came FROM the
  // select (naming a field absent on the live index, e.g. a room not yet cut over to the chunked
  // schema), repeating the select would 400 AGAIN and turn a graceful keyword degradation into a hard
  // throw. A bare keyword query is always valid on any index shape.
  const fallbackBody: Record<string, unknown> = { search: query, top: fetchTop, queryType: 'simple', searchMode: 'any' };

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
  const raw = (j.value || []).map((d, i) => ({
    score: (typeof d['@search.rerankerScore'] === 'number' ? d['@search.rerankerScore'] : d['@search.score']) as number | undefined,
    text: pickText(d).slice(0, 1200),
    id: d['id'] ?? d['chunk_id'] ?? d['key'] ?? '',
    type: typeof d['type'] === 'string' ? (d['type'] as string) : undefined,
    path: typeof d['path'] === 'string' ? (d['path'] as string) : undefined,
    // Authority/freshness signals for the memory-room re-rank (stripped before returning KbHit, so the
    // client output shape is unchanged). Absent on chunked doc rooms — those skip the re-rank anyway.
    ts: typeof d['ts'] === 'string' ? (d['ts'] as string) : undefined,
    source: typeof d['source'] === 'string' ? (d['source'] as string) : undefined,
    by: typeof d['by'] === 'string' ? (d['by'] as string) : undefined,
    // Dedup key for chunked rooms: the parent document. The `__row${i}` final fallback guarantees a
    // unique key when a doc has none of parent_id/path/id/chunk_id, so unrelated hits can never merge
    // onto an empty ''. Flat rooms never dedup (each is its own key).
    _parent: String(d['parent_id'] ?? d['path'] ?? d['id'] ?? d['chunk_id'] ?? `__row${i}`),
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
  } else {
    // FLAT MEMORY ROOMS (memory-exec, finance-cfo-memory, commons-*, legal-*-memory): re-rank by
    // authority + freshness so a stale/retracted episode can no longer outrank the current decision
    // or correction of near-equal relevance (Wave 1, the CORRECTION-plague fix). Chunked DOC rooms
    // (finance/legal source docs) never enter this branch, so document retrieval is untouched. The
    // re-rank is a no-op on rooms whose docs carry no type/ts/source (all multipliers -> 1.0, stable
    // sort preserves the engine's relevance order). Kill-switch: MEMORY_RERANK_MODE=off.
    hits = rerankByAuthority(hits, { mode: e.MEMORY_RERANK_MODE });
  }

  // Strip the internal dedup + re-rank signal keys; the client-side exhaust backstop (belt + braces)
  // still runs. The KbHit output shape is unchanged (ts/source/by never leave this function).
  let matches: KbHit[] = hits.map(({ _parent, ts, source, by, ...h }) => h);
  matches = filterExhaustHits(matches, includeOps);
  return { matches, mode: vector ? 'hybrid+semantic' : 'keyword' };
}

export interface FetchedDocument {
  /** The doc key as understood within this room (chunked rooms: the parent identifier, i.e. the
   *  same value hybridSearch cites as `id` for a chunked hit — see the CHUNKED-room note below). */
  key: string;
  title?: string;
  text: string;
  path?: string;
  /** 'direct' = flat-room GET-by-key. 'reassembled' = chunked-room chunks concatenated in order. */
  mode: 'direct' | 'reassembled';
}

/** Recover the numeric suffix of a `parentKey#N` chunk_id for ordering reassembled text. Missing/
 *  malformed suffixes sort first (0) rather than throwing — a best-effort order, never a hard fail. */
function chunkOrdinal(chunkId: unknown): number {
  const s = typeof chunkId === 'string' ? chunkId : '';
  const m = s.match(/#(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/**
 * Fetch ONE document by its room-scoped key — the get-by-key companion to hybridSearch's ranked
 * query, added for the OpenAI connector's `fetch` tool (src/tools/kb/openai-fetch.ts): resolve a
 * citation id into full text, rather than searching for one.
 *
 * FLAT rooms: `key` IS the index's real document key (the same value hybridSearch surfaces as
 * `id`), so this is a direct `GET /indexes/{index}/docs/{key}`.
 *
 * CHUNKED rooms (see isChunkedRoom): the index's real per-row key is `chunk_id` (one row per
 * CHUNK of a source document), but the "id" hybridSearch/brain_search cite for a chunked hit is the
 * PARENT identifier (parent_id, falling back to path/id/chunk_id — see hybridSearch's `_parent`
 * derivation above). A direct GET using that parent identifier as the key would 404 (it is not the
 * index's key field), so this reassembles the parent's text instead: query every chunk whose
 * parent_id matches `key`, order by chunk ordinal, and concatenate. Tries an exact server-side
 * `$filter` first (correct + cheap); on a 400 (parent_id not filterable on some room, or any other
 * filter rejection) or a thrown network error, falls back ONCE to a keyword search restricted to
 * parent_id/path with a client-side EXACT-match check on the results — approximate but never breaks
 * the room, and the exact-match check means a loose tokenized match can never leak an unrelated
 * document's chunks under this key. Mirrors hybridSearch's own try-filtered-then-fallback shape.
 *
 * Returns null when unconfigured, `key` is empty, or the document genuinely does not exist (404 /
 * no matching chunks / empty reassembled text). Throws only on a real transport/server error that
 * survives the one fallback attempt (mirrors hybridSearch's own contract: a filter problem never
 * throws, a real outage does).
 */
export async function getDocumentByKey(index: string, key: string): Promise<FetchedDocument | null> {
  const e = loadEnv();
  const ep = (e.AZURE_SEARCH_ENDPOINT || '').replace(/\/+$/, '');
  const searchKey = e.AZURE_SEARCH_QUERY_KEY || '';
  if (!ep || !searchKey || !key) return null;

  if (isChunkedRoom(index)) {
    return getChunkedDocument(ep, searchKey, index, key);
  }

  const r = await fetchWithBudget(
    `${ep}/indexes/${index}/docs/${encodeURIComponent(key)}?api-version=${API_VERSION}`,
    { method: 'GET', headers: { 'api-key': searchKey } },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`getDocumentByKey ${r.status}`);
  const doc = (await r.json()) as Record<string, unknown>;
  return {
    key,
    title: typeof doc['title'] === 'string' ? (doc['title'] as string) : undefined,
    text: pickText(doc),
    path: typeof doc['path'] === 'string' ? (doc['path'] as string) : undefined,
    mode: 'direct',
  };
}

async function getChunkedDocument(
  ep: string,
  searchKey: string,
  index: string,
  key: string,
): Promise<FetchedDocument | null> {
  const select = 'chunk_id,parent_id,title,path,chunk';
  const doSearch = (body: Record<string, unknown>) =>
    fetchWithBudget(`${ep}/indexes/${index}/docs/search?api-version=${API_VERSION}`, {
      method: 'POST',
      headers: { 'api-key': searchKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const escaped = key.replace(/'/g, "''");
  const primaryBody: Record<string, unknown> = { search: '*', filter: `parent_id eq '${escaped}'`, select, top: 50 };
  // Approximate fallback when the exact $filter itself is rejected: a plain keyword search
  // restricted to parent_id/path. The client-side EXACT match below still gates what survives.
  const fallbackBody: Record<string, unknown> = { search: key, searchFields: 'parent_id,path', queryType: 'simple', select, top: 50 };

  let r: Response;
  let usedFallback = false;
  try {
    r = await doSearch(primaryBody);
    if (r.status === 400) {
      r = await doSearch(fallbackBody);
      usedFallback = true;
    }
  } catch {
    r = await doSearch(fallbackBody);
    usedFallback = true;
  }
  if (!r.ok) throw new Error(`getDocumentByKey ${r.status}`);
  const j = (await r.json()) as { value?: Array<Record<string, unknown>> };
  let rows = j.value || [];
  if (usedFallback) {
    rows = rows.filter((d) => String(d['parent_id'] ?? '') === key || String(d['path'] ?? '') === key);
  }
  if (!rows.length) return null;
  rows.sort((a, b) => chunkOrdinal(a['chunk_id']) - chunkOrdinal(b['chunk_id']));
  const text = rows.map((d) => (typeof d['chunk'] === 'string' ? d['chunk'] : '')).filter(Boolean).join('\n\n');
  if (!text) return null;
  const first = rows[0];
  return {
    key,
    title: typeof first['title'] === 'string' ? (first['title'] as string) : undefined,
    text,
    path: typeof first['path'] === 'string' ? (first['path'] as string) : undefined,
    mode: 'reassembled',
  };
}
