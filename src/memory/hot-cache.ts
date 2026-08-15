/**
 * HOT tier: a read-through semantic cache in front of agenticRecall (the COLD tier).
 *
 * The four-tier memory brain is COLD (Azure AI Search memory-exec, query-plan -> hybrid ->
 * RRF, see agentic.ts) + WARM (Cosmos memory-write/search, see agentstate/memory.ts) + HOT
 * (this module) + the in-session working set. Repeated or near-duplicate recall queries
 * should not re-run the full agentic query-plan/hybrid/RRF pipeline every time; this module
 * checks a Cosmos vector cache first and serves a hit straight back.
 *
 * Storage: Cosmos DB for NoSQL, database agent-state, container `cache` (already provisioned,
 * partition key /cacheScope, 7-day TTL, DiskANN vector policy on `queryVector`, cosine, 3072
 * dims to match text-embedding-3-large). This module does not create the container.
 *
 * Safety:
 *  - cacheScope is ALWAYS the CALLER's own agent lane ("agent:<lane>", opts.scope, pass
 *    ctx.callerAgent), never the recall's content filter (opts.agent, forwarded unchanged to
 *    agenticRecall). This is deliberate: two different lanes asking the identical question
 *    must never share a cache entry, so the partition key is who is asking, not what filter
 *    they applied. Vector search is scoped to the caller's own partition only.
 *  - The clo-personal lane is privilege-walled and NEVER cached: bypassed entirely, both for
 *    reads (never search the cache) and writes (never persist a clo-personal query/result).
 *  - Graceful degradation: if Cosmos isn't configured (isConfigured() false) the cache is a
 *    clean no-op and callers get the exact agenticRecall behavior as if this module did not
 *    exist. A cache WRITE failure is swallowed (best-effort) and never surfaces to the caller
 *    or changes the returned recall result.
 *
 * Dependencies (embed / vector-search / upsert / the underlying recall) are threaded through
 * an optional `deps` bag, defaulting to the real Azure-backed implementations. This keeps the
 * module runnable end to end in production with zero extra wiring, while letting tests supply
 * fakes for the network-calling pieces without a mocking library (this repo's ESM build does
 * not support overriding another module's live named export at runtime).
 */

import { isConfigured, upsertDoc, vectorSearchDocs, newId, type VectorMatch } from '../agentstate/store.js';
import { embed as foundryEmbed } from '../azure/foundry.js';
import { agenticRecall, type AgenticRecallResult } from './agentic.js';

const CACHE_CONTAINER = 'cache';
const VECTOR_FIELD = 'queryVector';
/** Cosine similarity >= this counts as a near-duplicate prior query. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.97;
/** Mirrors the container's own defaultTtl (604800s / 7 days); documented here for clarity. */
export const CACHE_TTL_SECONDS = 604800;

/** The privilege-walled lane: never cached, in either direction. */
export const NEVER_CACHE_LANE = 'clo-personal';

export interface HotCacheDeps {
  isCosmosConfigured: () => boolean;
  embed: (text: string) => Promise<number[] | null>;
  vectorSearch: (
    coll: string,
    pkValue: string,
    vectorField: string,
    vector: number[],
    top?: number,
  ) => Promise<VectorMatch[]>;
  upsert: (coll: string, pkValue: string, doc: Record<string, unknown>) => Promise<unknown>;
  recall: (query: string, opts?: { agent?: string; top?: number }) => Promise<AgenticRecallResult>;
}

const defaultDeps: HotCacheDeps = {
  isCosmosConfigured: isConfigured,
  embed: foundryEmbed,
  vectorSearch: vectorSearchDocs,
  upsert: upsertDoc,
  recall: agenticRecall,
};

export interface HotCacheRecallOptions {
  /**
   * The CALLER's own agent lane (e.g. ctx.callerAgent from the gateway's OAuth identity).
   * This is the cache PARTITION key ("agent:<lane>"), it is who is asking, not a content
   * filter, so two different lanes never share a cache entry even when they ask the exact
   * same question. Leave unset/blank to skip the cache entirely (nothing to scope it to).
   */
  scope?: string;
  /** Forwarded unchanged to agenticRecall as its result-filtering `agent` option. */
  agent?: string;
  top?: number;
  similarityThreshold?: number;
  deps?: Partial<HotCacheDeps>;
}

export type HotCacheMode = AgenticRecallResult['mode'] | 'cache-hit';

export interface HotCacheRecallResult extends Omit<AgenticRecallResult, 'mode'> {
  mode: HotCacheMode;
  cacheHit: boolean;
}

interface CacheDoc {
  id: string;
  cacheScope: string;
  query: string;
  queryVector: number[];
  result: AgenticRecallResult;
  ts: string;
  ttl: number;
}

/** cacheScope is always the caller's agent lane, prefixed so it can never collide with another id shape. */
function scopeFor(lane: string): string {
  return `agent:${lane}`;
}

/**
 * Read-through cache around agenticRecall. Behaves identically to calling agenticRecall
 * directly whenever the cache is unconfigured, the lane is privilege-walled/blank, or
 * embedding fails; it only ever ADDS a fast path on top, never changes miss-path behavior.
 */
export async function cachedAgenticRecall(
  query: string,
  opts?: HotCacheRecallOptions,
): Promise<HotCacheRecallResult> {
  const deps: HotCacheDeps = { ...defaultDeps, ...opts?.deps };
  const scope = (opts?.scope ?? '').trim().toLowerCase();
  const threshold = opts?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // Privilege wall: clo-personal never touches the cache, in either direction. A blank scope
  // also skips the cache (there is no lane to partition it under).
  const cacheEligible = scope !== '' && scope !== NEVER_CACHE_LANE && deps.isCosmosConfigured();

  let queryVector: number[] | null = null;

  if (cacheEligible) {
    try {
      queryVector = await deps.embed(query);
      if (queryVector) {
        const hit = await lookupCache(deps, scope, queryVector, threshold);
        if (hit) {
          return { ...hit, mode: 'cache-hit', cacheHit: true };
        }
      }
    } catch {
      /* cache lookup is best-effort; fall through to a live recall on any failure */
      queryVector = null;
    }
  }

  const live = await deps.recall(query, { agent: opts?.agent, top: opts?.top });

  if (cacheEligible) {
    // Best-effort write-back; never let a cache-write failure affect the response.
    void writeCache(deps, scope, query, live, queryVector).catch(() => undefined);
  }

  return { ...live, cacheHit: false };
}

async function lookupCache(
  deps: HotCacheDeps,
  lane: string,
  vector: number[],
  threshold: number,
): Promise<AgenticRecallResult | null> {
  const scope = scopeFor(lane);
  const matches = await deps.vectorSearch(CACHE_CONTAINER, scope, VECTOR_FIELD, vector, 1);
  const top = matches[0];
  if (!top || top.similarity < threshold) return null;
  const doc = top.doc as unknown as CacheDoc;
  if (!doc || !doc.result) return null;
  return doc.result;
}

async function writeCache(
  deps: HotCacheDeps,
  lane: string,
  query: string,
  result: AgenticRecallResult,
  precomputedVector: number[] | null,
): Promise<void> {
  const vector = precomputedVector ?? (await deps.embed(query));
  if (!vector) return; // no vector, nothing useful to cache
  const scope = scopeFor(lane);
  const doc: CacheDoc = {
    id: newId('cache'),
    cacheScope: scope,
    query,
    queryVector: vector,
    result,
    ts: new Date().toISOString(),
    ttl: CACHE_TTL_SECONDS,
  };
  await deps.upsert(CACHE_CONTAINER, scope, doc as unknown as Record<string, unknown>);
}
