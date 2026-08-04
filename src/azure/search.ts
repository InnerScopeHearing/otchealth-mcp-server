/**
 * Shared hybrid retrieval over Azure AI Search (otchealth-dataroom-search).
 * Hybrid = BM25 keyword (search) + vector (contentVector via text-embedding-3-large) + 'sem'
 * semantic ranker, with graceful degradation to keyword-only on 400 / missing embeddings.
 * Read-only: uses AZURE_SEARCH_QUERY_KEY.
 *
 * ROOM HYGIENE (default, 2026-07-21 demote-not-delete): operational exhaust (status/episode/
 * heartbeat/digest-style chatter -- see src/memory/room-hygiene.ts) is DEPRIORITIZED, not removed,
 * from every call unless the caller opts in via `opts.includeOps`. A hard server-side $filter can
 * only ever exclude, never demote, so the default (no `opts.filter` given) query no longer applies
 * one: it fetches an over-fetched, unfiltered candidate pool, then room-hygiene's
 * `demoteExhaustHits` re-ranks that pool client-side so every exhaust-typed hit sorts after every
 * non-exhaust hit before the final truncation to `top`. This guarantees exhaust never crowds out a
 * genuine hit (as long as enough genuine hits exist in the fetched pool), while still letting an
 * exhaust hit surface when a room genuinely has nothing better -- see room-hygiene.ts's file header
 * for the recall regression this fixes. A caller that wants the OLD strict-exclusion behavior can
 * still get it by passing `buildExhaustFilterClause()` as `opts.filter` explicitly (see
 * room-hygiene.ts's updated doc comment on that helper). `opts` defaults to "no filtering, no
 * demotion" (the pre-existing, unchanged behavior) when omitted entirely, so any existing caller
 * that does not pass it (e.g. kb_search_privileged) is byte-for-byte unaffected; the tool layer
 * (brain_search, kb_search) is what makes demotion the default by always passing opts.
 *
 * SHADOW EVAL (Wave 7 item 7.2, default OFF -- see safety/shadow-eval.ts): `hybridSearch` is the
 * one seam every caller funnels through, so a sampled, fire-and-forget candidate-variant re-run is
 * wired in right here rather than at each of its ~7 call sites. It NEVER affects the value this
 * function returns; see the exported `hybridSearch` wrapper's own comment for exactly how.
 */
import { loadEnv } from '../config/env.js';
import { embed } from './foundry.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
import { demoteExhaustHits } from '../memory/room-hygiene.js';
import { rerankByAuthority, rerankEnabled } from '../memory/authority-rerank.js';
import {
  parseShadowEvalMode,
  parseShadowSampleRate,
  shouldSampleShadow,
  resolveShadowStrategy,
  captureShadowComparison,
  isRingGatedIndexName,
} from '../safety/shadow-eval.js';

const API_VERSION = '2023-11-01';

export interface KbHit {
  score: number | undefined;
  text: string;
  id: unknown;
  /** The record's discriminator (fact/decision/.../status/...), when the index carries one. */
  type?: string;
  /** Source path of the parent document (chunked doc rooms only), for citation. Flat rooms omit it. */
  path?: string;
  /** Other parent paths (chunked doc rooms only) collapsed into this hit because their content was
   *  BYTE-IDENTICAL to it (e.g. the same source document filed under two organizational prefixes).
   *  Present only when at least one alternate was collapsed; `path` above is the survivor (shallowest
   *  path). See the cross-parent content-dedup pass in runHybridSearch's chunked branch. */
  variants?: string[];
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

/**
 * hybridSearch is the single seam EVERY caller (kb_search, brain_search, kb_search_privileged,
 * incident_match, deep-retrieval, auto-supersede, ...) funnels through, so it is also the natural
 * seam for SHADOW EVAL (Wave 7 item 7.2, safety/shadow-eval.ts): a fire-and-forget, sampled,
 * candidate-variant re-run whose result is captured for offline comparison and NEVER returned to
 * the caller. This thin wrapper does exactly two things beyond the original behavior: it calls the
 * (renamed, otherwise byte-identical) internal implementation for the LIVE result, then, only
 * after that live result is already final, fires an un-awaited shadow re-run if
 * SHADOW_EVAL_MODE=on and this call was sampled. See runShadowEvalIfSampled below and
 * safety/shadow-eval.ts's file header for the full design.
 */
export async function hybridSearch(
  index: string,
  query: string,
  top: number,
  opts?: HybridSearchOptions,
): Promise<{ matches: KbHit[]; mode: string } | null> {
  const result = await runHybridSearch(index, query, top, opts);
  if (result) {
    // SHADOW EVAL: fired AFTER `result` is already computed and about to be returned unchanged.
    // Deliberately NOT awaited (`void ... .catch()`, matching safety/journal.ts's journalMutation
    // call-site convention exactly) so the shadow branch's own network calls can never add latency
    // to, or fail, this response. See azure/search.test.ts for a live proof that this function
    // resolves before the shadow branch's own fetch even settles.
    void runShadowEvalIfSampled(index, query, top, opts, result).catch(() => undefined);
  }
  return result;
}

/**
 * `rerankModeOverride`, when given, REPLACES the env-derived MEMORY_RERANK_MODE for this one call
 * only. Used exclusively by the shadow path (a strategy's `rerankModeOverride`) so a candidate
 * re-rank variant can diverge from the live env value without a second env mutation anywhere.
 * `undefined` (every pre-existing call site, including the public hybridSearch's own live-path
 * call above) reads process.env exactly as before this parameter existed: byte-identical
 * behavior for every caller that does not know this parameter exists.
 */
async function runHybridSearch(
  index: string,
  query: string,
  top: number,
  opts?: HybridSearchOptions,
  rerankModeOverride?: string,
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

  // Room hygiene no longer builds a hard exhaust $filter by default (see room-hygiene.ts's
  // 2026-07-21 CORRECTION): a $filter can only exclude, never demote, so demoting exhaust hits
  // needs them retrieved in the first place. The only $filter this function ever sends now is one
  // the CALLER supplies explicitly via opts.filter (e.g. incident-match's pitfall/correction-only
  // slice, or a caller that wants buildExhaustFilterClause()'s old strict-exclusion behavior on
  // purpose). Chunked doc rooms still never get a filter of any kind (no `type` field to filter
  // on; attaching one only ever 400s -> fail-open to keyword-only, silently dropping vector+semantic
  // recall). Flat rooms with no `type` field still 400 on a caller-supplied filter and fall through
  // the fail-open retry below to a filter-free query, exactly as before.
  const filter = chunked ? undefined : opts?.filter;

  // Chunked rooms return N chunks per parent doc; over-fetch so post-dedup we can still surface `top`
  // distinct parents. FLAT MEMORY rooms also over-fetch when the authority re-rank is active, or when
  // room-hygiene demotion is active (DEMOTE_MODE below), so there is a real candidate pool to reorder
  // -- otherwise a query could only ever reorder the exact `top` the engine returned and could never
  // promote a current decision (rerank) or a genuine non-exhaust hit (demotion) that relevance-ranked
  // just outside the naive window. With BOTH off, flat rooms fetch exactly `top` (byte-identical to
  // before). Both are skipped when the caller passed an explicit opts.filter: that means they asked
  // for a PRECISE slice (e.g. incident-match's pitfall/correction-only query) and want pure relevance
  // order within it, not a reshuffle. Demotion is also skipped when the caller asked for full
  // inclusion (includeOps=true) -- there is nothing to demote once everything is wanted.
  // Resolved ONCE and reused everywhere the rerank mode is consulted below (both the enabled-check
  // and rerankByAuthority's own call), so a shadow strategy's rerankModeOverride can never partially
  // apply -- e.g. override 'on' while env MEMORY_RERANK_MODE is 'off' must make rerankByAuthority
  // itself apply the multipliers, not just size the over-fetch pool as if it would.
  const rerankMode = rerankModeOverride ?? e.MEMORY_RERANK_MODE;
  const rerankOn = rerankEnabled(rerankMode) && !opts?.filter;
  const demoteMode = !chunked && !opts?.filter && !includeOps;
  const fetchTop = chunked ? Math.min(50, top * 3) : rerankOn || demoteMode ? Math.min(30, top * 3) : top;

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

  // FAIL-OPEN: a semantic/filter-layer problem must never take a room down. ANY non-2xx on the
  // enriched attempt (400 = semantic ranker unsupported / filter names an absent field, 402 =
  // semantic quota exhausted — the 2026-07-20 fleet-wide "brain offline" incident, 429 = throttled,
  // 5xx = transient service error) falls through ONCE to the plain, filter-free keyword query,
  // which has no metered/semantic dependency and is valid on any index shape. Only if the FALLBACK
  // itself is non-2xx do we throw — so a genuine full outage still surfaces, but a failure in any
  // enrichment layer (semantic billing, vectorizer, filter schema) degrades instead of going dark.
  let r: Response;
  try {
    r = await doSearch(body);
    if (!r.ok) {
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
    // Cross-parent content-dedup output (chunked rooms only; always undefined on a fresh row -- only
    // ever set by PASS 2 below when this row's content collapsed one or more sibling parents into
    // it). Declared here (rather than only on the merged branch) so every row has a statically
    // consistent shape and the final KbHit mapping never has to reason about a union type.
    _variantPaths: undefined as string[] | undefined,
  }));

  let hits = raw;
  if (chunked) {
    // Soft-deleted blobs (legal_blob_delete moves the original to _TRASH/<path>, PR #190) can still
    // be served by search until the room's next reindex -- a caller trusting search would otherwise
    // fetch a _TRASH/ path or cite a superseded document as current (confirmed live, CLO field report
    // 2026-08-04: kb_search_privileged returned a just-soft-deleted path at rank 2). Dropped BEFORE
    // the parent collapse below so a trashed chunk can never win the "highest score per parent"
    // contest and surface as the representative hit for its parent.
    const visible = raw.filter((h) => !h.path || !h.path.startsWith('_TRASH/'));

    // PASS 1 -- collapse chunks to their parent: keep the single highest-scored chunk per parent and
    // cite the parent (id = parent key, path = source path). Stops one document from filling the
    // result set with N of its own chunks, and makes `count` mean "distinct documents", not "chunks".
    const best = new Map<string, (typeof visible)[number]>();
    for (const h of visible) {
      const cur = best.get(h._parent);
      if (!cur || (h.score ?? -Infinity) > (cur.score ?? -Infinity)) best.set(h._parent, h);
    }
    const collapsed = [...best.values()];

    // PASS 2 (2026-08-04, CLO brief §2 ask #3 / live field-measured Finding 4) -- collapse across
    // DIFFERENT parent documents that are byte-identical copies of each other, e.g. the same source
    // document filed under two organizational prefixes (divorce/ vs clo-outgoing/01-Divorce/). Pass 1
    // only merges multiple CHUNKS of the SAME parent; it cannot catch this because the duplicates are
    // genuinely distinct parent_id/path values. Confirmed live as the DOMINANT remaining duplication
    // once legacy mirror-artifact debris was cleaned up (4 of 10 result slots on one real query,
    // with scores identical to 16 significant digits -- a strong but not proof-grade signal on its
    // own, so the actual grouping key is the exact projected chunk TEXT, not the score).
    //
    // Grouping key: the trimmed text, but only above a minimum length -- pickText can legitimately
    // return '' or a short fragment for some rows, and grouping THOSE together would incorrectly
    // merge unrelated documents that both happen to have little/no extractable text. Below the
    // threshold, each hit gets its own unique key (its parent id), so it is never merged with
    // anything else.
    const MIN_DEDUP_TEXT_LEN = 40;
    const contentKey = (h: (typeof collapsed)[number]): string => {
      const t = h.text.trim();
      return t.length >= MIN_DEDUP_TEXT_LEN ? t : `__unique_${h._parent}`;
    };
    const byContent = new Map<string, typeof collapsed>();
    for (const h of collapsed) {
      const key = contentKey(h);
      const group = byContent.get(key);
      if (group) group.push(h);
      else byContent.set(key, [h]);
    }
    // "Shallowest path" survives as canonical (fewest '/' segments, then shortest string, matching
    // the CLO's explicit ask), keeping the highest score seen across the group; the collapsed
    // alternates are recorded on the survivor's `variants` rather than silently dropped.
    const deduped = [...byContent.values()].map((group) => {
      if (group.length === 1) return group[0];
      const sorted = [...group].sort((a, b) => {
        const da = (a.path ?? '').split('/').length;
        const db = (b.path ?? '').split('/').length;
        if (da !== db) return da - db;
        return (a.path ?? '').length - (b.path ?? '').length;
      });
      const [canonical, ...rest] = sorted;
      const bestScore = Math.max(...group.map((g) => g.score ?? -Infinity));
      const variantPaths = rest.map((r) => r.path).filter((p): p is string => typeof p === 'string' && p.length > 0);
      return { ...canonical, score: bestScore, _variantPaths: variantPaths.length ? variantPaths : undefined };
    });

    hits = deduped
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, top)
      .map((h) => ({ ...h, id: h._parent || h.id }));
  } else {
    // FLAT MEMORY ROOMS (memory-exec, finance-cfo-memory, commons-*, legal-*-memory): re-rank by
    // authority + freshness so a stale/retracted episode can no longer outrank the current decision
    // or correction of near-equal relevance (Wave 1, the CORRECTION-plague fix). Chunked DOC rooms
    // (finance/legal source docs) never enter this branch, so document retrieval is untouched. The
    // re-rank is a no-op on rooms whose docs carry no type/ts/source (all multipliers -> 1.0, stable
    // sort preserves the engine's relevance order). Kill-switch: MEMORY_RERANK_MODE=off. When on, the
    // room over-fetched (fetchTop above) so the re-rank has a real candidate pool -- a current decision
    // that relevance-ranked at, say, #12 can be promoted ahead of a weaker hit. Truncation to `top`
    // happens LATER, after room-hygiene demotion (below), NOT here: slicing here first would let the
    // re-rank's own truncation permanently drop a genuine hit before demotion ever got a chance to
    // move a competing exhaust hit out of the way, which would reintroduce the exact "top slot crowded
    // out by chatter" failure this whole change exists to fix. rerankOn already folds in both the
    // kill-switch and the "no explicit filter" rule.
    if (rerankOn) hits = rerankByAuthority(hits, { mode: rerankMode });
  }

  // Strip the internal dedup + re-rank signal keys, then apply room hygiene as the FINAL step so it
  // sees (and truncates) the full over-fetched, re-ranked pool: demoteExhaustHits moves any
  // exhaust-typed hit to the end (never crowding out a non-exhaust hit that fits within `top`, but
  // never permanently dropping one either) and only then slices to `top`. `includeOps=true` is a
  // no-op reorder, just the same `top` truncation every caller already expects. _variantPaths is
  // promoted to the public `variants` field (only when non-empty -- absent on every flat-room hit
  // and on a chunked hit with no collapsed sibling, so the KbHit shape is unchanged for every
  // existing caller that never sees a variants key today).
  let matches: KbHit[] = hits.map(({ _parent, ts, source, by, _variantPaths, ...h }) => ({
    ...h,
    ...(_variantPaths && _variantPaths.length ? { variants: _variantPaths } : {}),
  }));
  matches = demoteExhaustHits(matches, includeOps, top);
  return { matches, mode: vector ? 'hybrid+semantic' : 'keyword' };
}

/**
 * SHADOW EVAL orchestration (Wave 7 item 7.2). Decides whether THIS call should also run a
 * candidate variant, and if so runs it + captures the comparison. Never awaited by the public
 * hybridSearch wrapper above (see its own comment). Everything in this function happens strictly
 * AFTER the live result the caller receives is already final.
 *
 * Every step here fails open: an unset/garbage SHADOW_EVAL_MODE is 'off' (no-op, the common case
 * for the fleet today); an unset/garbage SHADOW_EVAL_STRATEGY resolves to 'baseline' rather than
 * throwing; a thrown error from the candidate re-run itself is caught and captured as
 * `shadowError` rather than propagated (this function's own promise still resolves cleanly, and
 * the call site's `.catch(() => undefined)` is defense in depth on top of that). Nothing in this
 * function can throw synchronously before its first await either, so `void runShadowEvalIfSampled(
 * ...)` at the call site can never itself throw.
 */
async function runShadowEvalIfSampled(
  index: string,
  query: string,
  top: number,
  opts: HybridSearchOptions | undefined,
  liveResult: { matches: KbHit[]; mode: string },
): Promise<void> {
  if (parseShadowEvalMode(process.env.SHADOW_EVAL_MODE) !== 'on') return;
  // CROSS-RING GATE: never even RUN a shadow re-run for a ring-gated (kb_search_privileged-only)
  // index -- the comparison record's destination (memory-exec, via captureShadowComparison's
  // default) is an OPEN index, a more permissive destination than the ring-gated room the live
  // query was actually against. Checked here (not just inside captureShadowComparison) so a
  // privileged room's query never even pays the extra embed+search cost, and so there is no window
  // where a ring-gated result briefly exists before capture. See shadow-eval.ts's own header.
  if (isRingGatedIndexName(index)) return;
  const rate = parseShadowSampleRate(process.env.SHADOW_EVAL_SAMPLE_RATE);
  // Math.random() here (never in the pure shouldSampleShadow itself, which takes `rand` as a
  // parameter precisely so it stays seedable/testable) -- see shadow-eval.ts's file header.
  if (!shouldSampleShadow(rate, Math.random)) return;

  const strategy = resolveShadowStrategy(process.env.SHADOW_EVAL_STRATEGY);
  const shadowOpts: HybridSearchOptions = { ...opts };
  if (strategy.overrides.includeOpsOverride !== undefined) {
    shadowOpts.includeOps = strategy.overrides.includeOpsOverride;
  }

  const startedAt = Date.now();
  let shadowResult: { matches: KbHit[]; mode: string } | null = null;
  let shadowError: string | undefined;
  try {
    shadowResult = await runHybridSearch(index, query, top, shadowOpts, strategy.overrides.rerankModeOverride);
  } catch (err) {
    shadowError = err instanceof Error ? err.message : String(err);
  }
  const elapsedMs = Date.now() - startedAt;

  await captureShadowComparison({
    index,
    query,
    top,
    strategy: strategy.name,
    live: { mode: liveResult.mode, hits: liveResult.matches },
    shadow: shadowResult ? { mode: shadowResult.mode, hits: shadowResult.matches } : null,
    shadowError,
    elapsedMs,
  });
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
