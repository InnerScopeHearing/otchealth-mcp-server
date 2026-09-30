/**
 * HOT tier: a read-through semantic cache in front of agenticRecall (the COLD tier).
 *
 * The four-tier memory brain is COLD (selected search backend memory-exec, query-plan -> hybrid ->
 * RRF, see agentic.ts) + WARM (selected-store memory-write/search, see agentstate/memory.ts) + HOT
 * (this module) + the in-session working set. Repeated or near-duplicate recall queries
 * should not re-run the full agentic query-plan/hybrid/RRF pipeline every time; this module
 * checks the selected backend's vector cache first and serves a valid hit straight back.
 *
 * Storage: the selected agent-state backend's `cache` collection/table (the dispatcher defaults
 * to Postgres in production). Cache rows carry a seven-day TTL; expiration is also checked here
 * because not every backend physically enforces TTL. This module creates no storage resources.
 *
 * Safety:
 *  - cacheScope partitions by caller lane AND the result-changing recall parameters (`agent`,
 *    `top`). This prevents both cross-lane sharing and stale results across content filters or
 *    limits. Vector search is scoped to the resulting deterministic partition only.
 *  - The clo-personal lane is privilege-walled and NEVER cached: bypassed entirely, both for
 *    reads (never search the cache) and writes (never persist a clo-personal query/result).
 *  - Graceful degradation: if the selected state store isn't configured (`isConfigured()` is
 *    false) the cache is a clean no-op and callers get the exact agenticRecall behavior as if it did not
 *    exist. A cache WRITE failure is swallowed (best-effort) and never surfaces to the caller
 *    or changes the returned recall result.
 *
 * Dependencies (embed / vector-search / upsert / the underlying recall) are threaded through
 * an optional `deps` bag, defaulting to the real configured implementations. This keeps the
 * module runnable end to end in production with zero extra wiring, while letting tests supply
 * fakes for the network-calling pieces without a mocking library (this repo's ESM build does
 * not support overriding another module's live named export at runtime).
 */

import { createHash } from 'node:crypto';
import { isConfigured, upsertDoc, vectorSearchDocs, newId, type VectorMatch } from '../agentstate/store.js';
import { embed as foundryEmbed } from '../azure/foundry.js';
import { agenticRecall, DEFAULT_TOP, type AgenticRecallResult } from './agentic.js';

const CACHE_CONTAINER = 'cache';
const VECTOR_FIELD = 'queryVector';
/** Cosine similarity >= this counts as a near-duplicate prior query. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.97;
/** Maximum cache lifetime in seconds. All backends enforce it through read-time validation. */
export const CACHE_TTL_SECONDS = 604800;

/** The privilege-walled lane: never cached, in either direction. */
export const NEVER_CACHE_LANE = 'clo-personal';

export interface HotCacheDeps {
  isStoreConfigured: () => boolean;
  nowMs: () => number;
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
  isStoreConfigured: isConfigured,
  nowMs: Date.now,
  embed: foundryEmbed,
  vectorSearch: vectorSearchDocs,
  upsert: upsertDoc,
  recall: agenticRecall,
};

export interface HotCacheRecallOptions {
  /**
   * The CALLER's own agent lane (e.g. ctx.callerAgent from the gateway's OAuth identity).
   * It remains one component of the cache partition so different caller lanes never share.
   * Leave unset/blank to skip the cache entirely (nothing to scope it to).
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

interface RecallCacheDimensions {
  agent: string | null;
  top: number;
}

/** Resolve effective result-changing parameters without changing the live recall call. */
function cacheDimensions(opts?: Pick<HotCacheRecallOptions, 'agent' | 'top'>): RecallCacheDimensions | null {
  const top = opts?.top ?? DEFAULT_TOP;
  if (!Number.isSafeInteger(top) || top < 1) return null;
  return { agent: opts?.agent || null, top };
}

/** Hash a fixed-order canonical contract so caller-provided filter text is not a raw partition key. */
function scopeFor(lane: string, dimensions: RecallCacheDimensions): string {
  const canonical = JSON.stringify({ agent: dimensions.agent, top: dimensions.top });
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `agent:${lane}:recall:${digest}`;
}

function isLiveCacheDoc(value: unknown, nowMs: number): value is CacheDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<CacheDoc>;
  if (!doc.result || typeof doc.result !== 'object') return false;
  if (typeof doc.ts !== 'string' || typeof doc.ttl !== 'number' || !Number.isSafeInteger(doc.ttl) || doc.ttl < 1 || doc.ttl > CACHE_TTL_SECONDS) return false;

  const timestamp = Date.parse(doc.ts);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== doc.ts || timestamp > nowMs) return false;
  const expiresAt = timestamp + doc.ttl * 1000;
  return Number.isFinite(expiresAt) && nowMs < expiresAt;
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
  const dimensions = cacheDimensions(opts);

  // Privilege wall: clo-personal never touches the cache, in either direction. A blank scope
  // also skips the cache (there is no lane to partition it under).
  const cacheEligible = scope !== '' && scope !== NEVER_CACHE_LANE && dimensions !== null && deps.isStoreConfigured();
  const cacheScope = cacheEligible ? scopeFor(scope, dimensions!) : null;

  let queryVector: number[] | null = null;

  if (cacheEligible) {
    try {
      queryVector = await deps.embed(query);
      if (queryVector) {
        const hit = await lookupCache(deps, cacheScope!, queryVector, threshold);
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
    void writeCache(deps, cacheScope!, query, live, queryVector).catch(() => undefined);
  }

  return { ...live, cacheHit: false };
}

async function lookupCache(
  deps: HotCacheDeps,
  cacheScope: string,
  vector: number[],
  threshold: number,
): Promise<AgenticRecallResult | null> {
  const matches = await deps.vectorSearch(CACHE_CONTAINER, cacheScope, VECTOR_FIELD, vector, 1);
  const top = matches[0];
  if (!top || top.similarity < threshold) return null;
  const doc = top.doc;
  if (!isLiveCacheDoc(doc, deps.nowMs())) return null;
  return doc.result;
}

async function writeCache(
  deps: HotCacheDeps,
  cacheScope: string,
  query: string,
  result: AgenticRecallResult,
  precomputedVector: number[] | null,
): Promise<void> {
  const vector = precomputedVector ?? (await deps.embed(query));
  if (!vector) return; // no vector, nothing useful to cache
  const doc: CacheDoc = {
    id: newId('cache'),
    cacheScope,
    query,
    queryVector: vector,
    result,
    ts: new Date(deps.nowMs()).toISOString(),
    ttl: CACHE_TTL_SECONDS,
  };
  await deps.upsert(CACHE_CONTAINER, cacheScope, doc as unknown as Record<string, unknown>);
}
