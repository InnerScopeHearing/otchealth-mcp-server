/**
 * Amazon OpenSearch adapter for the gateway's knowledge-retrieval surface -- the OpenSearch-backed
 * counterpart to src/azure/search.ts, exposing the SAME public interface (hybridSearch,
 * getDocumentByKey, searchConfigured) so every existing caller works unmodified once
 * SEARCH_BACKEND=opensearch (see src/search/index.ts, the dispatcher that actually switches
 * between the two). Read-only: this module never writes an index.
 *
 * ROOM/INDEX NAMES: identical to the Azure rooms by design (see the migration task description) --
 * commerce-commerce-source-docs, commons-*, cs-knowledge, finance-*, legal-*, memory-exec. Which
 * rooms are CHUNKED (child-doc-per-source-chunk, vector field `text_vector`) vs FLAT (one doc per
 * record, vector field `contentVector`) is governed by the SAME registry Azure uses
 * (azure/search.ts's isChunkedRoom/CHUNKED_ROOMS) -- reused here verbatim rather than duplicated,
 * since the room shape is a property of the DATA, not of which search engine serves it.
 *
 * HYBRID RANKING DESIGN DECISION: OpenSearch has no equivalent of Azure AI Search's built-in
 * `queryType:'semantic'` L2 reranker. Rather than depend on the OpenSearch neural-search plugin's
 * "hybrid query" search pipeline (an index-level feature that may or may not be configured on the
 * live domain -- unverified from here, see the PR description's "unverified" list), this issues
 * TWO plain queries against the SAME index (a `multi_match` BM25 keyword query and, when an
 * embedding is available, a k-NN vector query) and merges their rankings CLIENT-SIDE with
 * Reciprocal Rank Fusion (RRF): score(doc) = sum over each list the doc appears in of
 * 1 / (RRF_K + rank_in_that_list), RRF_K = 60 (the standard constant from the original Cormack et
 * al. RRF paper and OpenSearch's own hybrid-query default). RRF was chosen over a raw
 * score-normalized sum because BM25 and cosine-similarity scores live on very different, non-
 * comparable scales -- RRF only needs each list's RANK ORDER, which is robust to that scale
 * mismatch and requires no query-time normalization tuning. This has NOT been benchmarked against
 * Azure's semantic reranker for result quality -- flagged as unverified in the PR description.
 *
 * FAIL-OPEN: mirrors azure/search.ts's contract as closely as possible. An embed() failure
 * degrades to keyword-only (vector query skipped, RRF over one list only, `mode` reports
 * 'keyword'). A non-2xx or thrown error from the PRIMARY (filtered, if opts.filter given) BM25
 * query retries once with a plain, filter-free multi_match; only if THAT also fails does this
 * throw (a genuine outage surfaces; a filter/schema problem degrades).
 */
import { loadEnv } from '../config/env.js';
import { embed } from '../azure/foundry.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { resolveAwsCredentials, signRequest } from './sigv4.js';
import { isChunkedRoom, pickText, type KbHit, type FetchedDocument, type HybridSearchOptions } from '../azure/search.js';
import { demoteExhaustHits } from '../memory/room-hygiene.js';
import { rerankByAuthority, rerankEnabled } from '../memory/authority-rerank.js';

const RRF_K = 60;
/** Fields the BM25 side searches, matching the room registry's documented text fields. Chunked doc
 *  rooms carry `chunk`/`title`/`path`; flat memory rooms carry `content`/`summary`/`text`. Both
 *  request the union -- an absent field simply never matches, no error. */
const BM25_FIELDS = ['title^2', 'content', 'chunk', 'summary', 'text'];

export function searchConfigured(): boolean {
  const e = loadEnv();
  if (!e.OPENSEARCH_ENDPOINT) return false;
  if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY) return true;
  // The ECS task-role fallback (see sigv4.ts) is only USABLE inside an ECS task, but its presence
  // is a reasonable "configured" signal here -- resolveAwsCredentials() is the actual gate that
  // matters at call time and fails closed (returns null) if the endpoint turns out unreachable.
  return Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
}

/** Which knn_vector field a room's index carries, per the task's fixed room registry: chunked doc
 *  rooms (Phase-3 S1 integrated vectorization, same registry Azure uses) index `text_vector`;
 *  every flat room (the memory-* rooms plus cs-knowledge) indexes `contentVector`. Exported for a
 *  direct unit test rather than only exercised indirectly through a stubbed hybridSearch call. */
export function vectorFieldFor(index: string): string {
  return isChunkedRoom(index) ? 'text_vector' : 'contentVector';
}

async function signedSearchFetch(index: string, body: Record<string, unknown>): Promise<Response> {
  const e = loadEnv();
  const host = (e.OPENSEARCH_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('opensearch credentials unavailable');
  const path = `/${index}/_search`;
  const bodyStr = JSON.stringify(body);
  const signed = signRequest({
    method: 'POST',
    host,
    path,
    body: bodyStr,
    region: e.OPENSEARCH_REGION || 'us-east-1',
    service: 'es',
    credentials,
  });
  return fetchWithBudget(`https://${host}${path}`, { method: 'POST', headers: signed.headers, body: bodyStr });
}

async function signedGetFetch(index: string, key: string): Promise<Response> {
  const e = loadEnv();
  const host = (e.OPENSEARCH_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const credentials = await resolveAwsCredentials();
  if (!credentials) throw new Error('opensearch credentials unavailable');
  const path = `/${index}/_doc/${encodeURIComponent(key)}`;
  const signed = signRequest({ method: 'GET', host, path, region: e.OPENSEARCH_REGION || 'us-east-1', service: 'es', credentials });
  return fetchWithBudget(`https://${host}${path}`, { method: 'GET', headers: signed.headers });
}

/**
 * Best-effort translation of the small set of Azure OData $filter shapes this gateway actually
 * generates (see room-hygiene.ts's buildExhaustFilterClause and incident-match.ts's
 * buildTypeInFilterClause -- both single-field, single-operator chains) into an OpenSearch terms
 * filter. Anything it cannot confidently parse returns null -- the caller treats that exactly like
 * Azure's own 400-on-unsupported-filter fail-open: drop the filter and query unfiltered, never
 * throw. This is NOT a general OData parser and is not meant to be.
 */
export function translateODataFilter(filter: string | undefined): { must?: unknown[]; mustNot?: unknown[] } | null {
  if (!filter) return null;
  const eqClauses = [...filter.matchAll(/(\w+)\s+eq\s+'((?:[^']|'')*)'/g)];
  const neClauses = [...filter.matchAll(/(\w+)\s+ne\s+'((?:[^']|'')*)'/g)];
  const unescape = (v: string) => v.replace(/''/g, "'");
  if (eqClauses.length && !neClauses.length && / or /.test(filter)) {
    const field = eqClauses[0][1];
    if (eqClauses.every((m) => m[1] === field)) {
      const values = eqClauses.map((m) => unescape(m[2]));
      return { must: [{ terms: { [field]: values } }] };
    }
  }
  if (neClauses.length && !eqClauses.length) {
    const field = neClauses[0][1];
    if (neClauses.every((m) => m[1] === field)) {
      const values = neClauses.map((m) => unescape(m[2]));
      return { mustNot: [{ terms: { [field]: values } }] };
    }
  }
  return null; // unrecognized shape -> fail open, no filter applied
}

interface RawHit {
  id: string;
  score: number | undefined; // native engine score, kept only for the rerank/dedup that needs it
  source: Record<string, unknown>;
}

function extractHits(json: unknown): RawHit[] {
  const hits = (json as { hits?: { hits?: Array<Record<string, unknown>> } })?.hits?.hits ?? [];
  return hits.map((h) => ({
    id: String(h['_id'] ?? ''),
    score: typeof h['_score'] === 'number' ? (h['_score'] as number) : undefined,
    source: (h['_source'] as Record<string, unknown>) ?? {},
  }));
}

/** Reciprocal Rank Fusion over N ranked lists of doc ids. Returns a Map<id, rrfScore>. Pure. */
export function reciprocalRankFusion(lists: RawHit[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      if (!hit.id) return;
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

export async function hybridSearch(
  index: string,
  query: string,
  top: number,
  opts?: HybridSearchOptions,
): Promise<{ matches: KbHit[]; mode: string } | null> {
  const e = loadEnv();
  if (!e.OPENSEARCH_ENDPOINT) return null;

  const includeOps = opts?.includeOps ?? true;
  const chunked = isChunkedRoom(index);
  const vecField = vectorFieldFor(index);

  let vector: number[] | null = null;
  try {
    vector = await embed(query);
  } catch {
    vector = null;
  }

  const rerankOn = rerankEnabled(e.MEMORY_RERANK_MODE) && !opts?.filter;
  const demoteMode = !chunked && !opts?.filter && !includeOps;
  const fetchTop = chunked ? Math.min(50, top * 3) : rerankOn || demoteMode ? Math.min(30, top * 3) : top;

  const translated = chunked ? null : translateODataFilter(opts?.filter);
  const filterClauses = [...(translated?.must ?? [])];
  const mustNotClauses = [...(translated?.mustNot ?? [])];

  const bm25Body = (withFilter: boolean): Record<string, unknown> => ({
    size: fetchTop,
    _source: { excludes: [vecField] },
    query: {
      bool: {
        must: [{ multi_match: { query, fields: BM25_FIELDS, type: 'best_fields' } }],
        ...(withFilter && filterClauses.length ? { filter: filterClauses } : {}),
        ...(withFilter && mustNotClauses.length ? { must_not: mustNotClauses } : {}),
      },
    },
  });

  // k-NN "efficient filtering": when a translated filter exists, thread it into the knn clause's
  // own `filter` sub-field (the k-NN plugin's documented pattern for combining an approximate
  // vector search with a boolean pre-filter on faiss/lucene engines) rather than wrapping the knn
  // query in an outer bool -- an outer bool + knn combination is NOT guaranteed to pre-filter
  // before the approximate search runs. UNVERIFIED against the live domain (see PR description).
  const knnClause: Record<string, unknown> = { vector, k: fetchTop };
  if (filterClauses.length || mustNotClauses.length) {
    knnClause.filter = { bool: { ...(filterClauses.length ? { filter: filterClauses } : {}), ...(mustNotClauses.length ? { must_not: mustNotClauses } : {}) } };
  }
  const knnBody: Record<string, unknown> | null = vector
    ? { size: fetchTop, _source: { excludes: [vecField] }, query: { knn: { [vecField]: knnClause } } }
    : null;

  // AT MOST TWO attempts, matching azure/search.ts's runHybridSearch's DOCUMENTED contract (one
  // primary, filtered-if-any query; ONE fallback to the plain filter-free query on either a non-2xx
  // OR a thrown error). Deliberately checks `!bmRes.ok` OUTSIDE the try/catch (not inside it) so a
  // failed FALLBACK throws immediately instead of being re-caught and retried a third, redundant
  // time with the identical filter-free body -- an earlier draft of this function did exactly that
  // (the fallback's own `!r.ok` throw landed inside the try block, so a genuine double-failure paid
  // for a third, wasted network round trip before finally surfacing).
  let bmRes: Response;
  try {
    bmRes = await signedSearchFetch(index, bm25Body(true));
    if (!bmRes.ok) bmRes = await signedSearchFetch(index, bm25Body(false));
  } catch {
    bmRes = await signedSearchFetch(index, bm25Body(false));
  }
  if (!bmRes.ok) throw new Error(`opensearch search ${bmRes.status}`);
  const bmHits = extractHits(await bmRes.json());

  let vecHits: RawHit[] = [];
  let usedVector = false;
  if (knnBody) {
    try {
      const r = await signedSearchFetch(index, knnBody);
      if (r.ok) {
        vecHits = extractHits(await r.json());
        usedVector = true;
      }
    } catch {
      vecHits = []; // vector side is best-effort; keyword result alone is still a valid answer
    }
  }

  const rrf = reciprocalRankFusion(usedVector ? [bmHits, vecHits] : [bmHits]);
  const bySource = new Map<string, Record<string, unknown>>();
  for (const h of [...bmHits, ...vecHits]) if (h.id && !bySource.has(h.id)) bySource.set(h.id, h.source);

  let raw = [...rrf.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, rrfScore]) => {
      const doc = bySource.get(id) ?? {};
      return {
        score: rrfScore,
        text: pickText(doc).slice(0, 1200),
        id: (doc['id'] as string | undefined) ?? (doc['chunk_id'] as string | undefined) ?? id,
        type: typeof doc['type'] === 'string' ? (doc['type'] as string) : undefined,
        path: typeof doc['path'] === 'string' ? (doc['path'] as string) : undefined,
        ts: typeof doc['ts'] === 'string' ? (doc['ts'] as string) : undefined,
        source: typeof doc['source'] === 'string' ? (doc['source'] as string) : undefined,
        by: typeof doc['by'] === 'string' ? (doc['by'] as string) : undefined,
        _parent: String(doc['parent_id'] ?? doc['path'] ?? doc['id'] ?? doc['chunk_id'] ?? id),
      };
    });

  let hits = raw;
  if (chunked) {
    // Parent-collapse only (Azure's PASS 1): keep the single highest-scored chunk per parent doc,
    // cite the parent. Azure's additional cross-parent BYTE-IDENTICAL-content dedup (its PASS 2) is
    // NOT reimplemented here -- flagged as a known gap in the PR description, not attempted blind.
    const best = new Map<string, (typeof raw)[number]>();
    for (const h of raw) {
      const cur = best.get(h._parent);
      if (!cur || h.score > cur.score) best.set(h._parent, h);
    }
    hits = [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, top)
      .map((h) => ({ ...h, id: h._parent || h.id }));
  } else if (rerankOn) {
    hits = rerankByAuthority(raw, { mode: e.MEMORY_RERANK_MODE });
  }

  let matches: KbHit[] = hits.map(({ _parent, ts, source, by, ...h }) => ({ ...h }));
  matches = demoteExhaustHits(matches, includeOps, top);
  return { matches, mode: usedVector ? 'hybrid' : 'keyword' };
}

/** Recover the numeric suffix of a `parentKey#N` chunk_id for ordering reassembled text. Mirrors
 *  azure/search.ts's (unexported) chunkOrdinal exactly; duplicated here rather than exported from
 *  that file since it is a tiny pure helper and this module otherwise avoids reaching into Azure
 *  internals beyond the shared, genuinely cross-backend room registry (isChunkedRoom/pickText). */
function chunkOrdinal(chunkId: unknown): number {
  const s = typeof chunkId === 'string' ? chunkId : '';
  const m = s.match(/#(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

export async function getDocumentByKey(index: string, key: string): Promise<FetchedDocument | null> {
  const e = loadEnv();
  if (!e.OPENSEARCH_ENDPOINT || !key) return null;

  if (!isChunkedRoom(index)) {
    const r = await signedGetFetch(index, key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`opensearch getDocumentByKey ${r.status}`);
    const j = (await r.json()) as { _source?: Record<string, unknown> };
    const doc = j._source ?? {};
    return {
      key,
      title: typeof doc['title'] === 'string' ? (doc['title'] as string) : undefined,
      text: pickText(doc),
      path: typeof doc['path'] === 'string' ? (doc['path'] as string) : undefined,
      mode: 'direct',
    };
  }

  // Chunked room: gather every chunk whose parent_id matches `key`, in ordinal order.
  const body = {
    size: 50,
    _source: { excludes: ['text_vector'] },
    query: { bool: { filter: [{ term: { parent_id: key } }] } },
  };
  // Fallback: a keyword search restricted to parent_id/path, with a client-side exact check --
  // mirrors azure/search.ts's own filter-rejected fallback shape. Triggered on EITHER a non-2xx
  // from the primary term-filter query OR a thrown network error (the primary attempt is wrapped
  // in try/catch for exactly that reason -- an unwrapped primary call would let a transient network
  // error propagate uncaught instead of getting the same one fallback chance hybridSearch's own
  // BM25 path gets above).
  const fallbackBody = {
    size: 50,
    _source: { excludes: ['text_vector'] },
    query: { multi_match: { query: key, fields: ['parent_id', 'path'] } },
  };
  let r: Response;
  let usedFallback = false;
  try {
    r = await signedSearchFetch(index, body);
    if (!r.ok) {
      r = await signedSearchFetch(index, fallbackBody);
      usedFallback = true;
    }
  } catch {
    r = await signedSearchFetch(index, fallbackBody);
    usedFallback = true;
  }
  if (!r.ok) throw new Error(`opensearch getDocumentByKey ${r.status}`);
  let rows = extractHits(await r.json());
  if (usedFallback) {
    rows = rows.filter((h) => String(h.source['parent_id'] ?? '') === key || String(h.source['path'] ?? '') === key);
  }
  return assembleChunked(key, rows);
}

function assembleChunked(key: string, rows: RawHit[]): FetchedDocument | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => chunkOrdinal(a.source['chunk_id']) - chunkOrdinal(b.source['chunk_id']));
  const text = sorted
    .map((r) => (typeof r.source['chunk'] === 'string' ? (r.source['chunk'] as string) : ''))
    .filter(Boolean)
    .join('\n\n');
  if (!text) return null;
  const first = sorted[0].source;
  return {
    key,
    title: typeof first['title'] === 'string' ? (first['title'] as string) : undefined,
    text,
    path: typeof first['path'] === 'string' ? (first['path'] as string) : undefined,
    mode: 'reassembled',
  };
}
