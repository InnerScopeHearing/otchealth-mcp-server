/**
 * Semantic response cache for llm_azure — a cache-check BEFORE the Foundry chat completion call.
 * Pattern = Azure AI App Template #35 (Redis semantic caching for LLM gateways), adapted
 * cost-neutrally: cost-neutral means using infra the fleet ALREADY pays for, so this reuses
 * the Cosmos DB `cache` container (agent-state, DiskANN vector policy, cosine, 3072 dims) that
 * memory/hot-cache.ts already established for memory_recall, instead of standing up a new
 * Azure Cache for Redis Enterprise instance (a new cash line) or a new Azure AI Search index.
 *
 * STORE CHOICE: Cosmos DB (not Redis Enterprise, not a new AI Search index). Why:
 *  - Redis Enterprise / Azure Managed Redis (the App Template #35 default) needs the RediSearch/
 *    vector module, which only ships on Enterprise-tier SKUs — a NEW metered resource. Cost-neutral
 *    rules this out; we are not adding a cash line to save Claude tokens.
 *  - Azure AI Search is credit-funded and was the requested first choice, but the gateway only
 *    holds a READ-ONLY query key for it (AZURE_SEARCH_QUERY_KEY) — writes to memory-exec happen
 *    through an external indexer pipeline the gateway does not own. Standing up cache writes there
 *    means minting a new admin key + a new index + index-schema management: new surface area, not
 *    reuse. It is not "clean" by the bar this task set.
 *  - Cosmos DB (agent-state) is ALREADY credit-funded, ALREADY holds an admin key on this gateway,
 *    ALREADY has a purpose-built `cache` container (7-day TTL, DiskANN vector index on 3072-dim
 *    embeddings) proven in production by memory/hot-cache.ts. Reusing it for the LLM response
 *    cache is the only option here that adds zero new infrastructure and zero new secrets.
 * A future Redis-backed cache remains an option if Cosmos RU costs become the binding constraint,
 * but that is a call for the CTO to make once there is real hit-rate/RU telemetry to look at.
 *
 * PARTITION: cache entries are scoped ("llm:<callerAgent>:<task>:<tier>") so a CFO invoice
 * classification never serves a CLO clause-lookup's cached answer, and gpt-5.1 output never
 * serves as a gpt-5.4 answer. Every prompt-shaping input that could change the correct answer
 * (task type, tier/deployment, and the caller's own lane) is baked into the partition key, on
 * top of the embedding-similarity check on the actual prompt text.
 *
 * MODE-GATED + FAIL-OPEN (same shape as COMPLIANCE_MODE / SHIELD_MODE / GROUNDEDNESS_MODE):
 *   LLM_CACHE_MODE: off (default) | on
 *     off -> never touched; llm_azure behaves exactly as before this module existed.
 *     on  -> cache-check before every eligible llm_azure call; on any cache failure (Cosmos down,
 *            embed() throws, malformed doc, etc.) this degrades silently to a normal LLM call.
 *            A cache dependency must never take a real model call down.
 *   LLM_CACHE_SIMILARITY_THRESHOLD: cosine similarity floor for a hit (default 0.95; slightly
 *     looser than memory-recall's 0.97 because near-duplicate INVOICE/CLAUSE/COPY prompts vary
 *     more in exact wording than repeat recall queries, but still conservative — a false hit
 *     silently returns someone else's cached answer).
 *   LLM_CACHE_TTL_SECONDS: informational only here; the underlying `cache` container's TTL
 *     already governs physical expiry (see memory/hot-cache.ts CACHE_TTL_SECONDS).
 */

import { isConfigured, upsertDoc, vectorSearchDocs, newId, type VectorMatch } from '../../agentstate/store.js';
import { embed as foundryEmbed } from '../../azure/foundry.js';

const CACHE_CONTAINER = 'cache';
const VECTOR_FIELD = 'queryVector';
const CACHE_TTL_SECONDS = 604800; // mirrors the `cache` container's own defaultTtl (7 days)

export const DEFAULT_SIMILARITY_THRESHOLD = 0.95;

/** Never cache the privilege-walled lane, mirroring memory/hot-cache.ts's NEVER_CACHE_LANE. */
export const NEVER_CACHE_LANE = 'clo-personal';

export type CacheModeValue = 'off' | 'on';

/** Read LLM_CACHE_MODE fresh from process.env, like COMPLIANCE_MODE/SHIELD_MODE. Defaults to 'off'. */
export function cacheMode(): CacheModeValue {
  return (process.env.LLM_CACHE_MODE || '').trim().toLowerCase() === 'on' ? 'on' : 'off';
}

/** Read LLM_CACHE_SIMILARITY_THRESHOLD fresh from process.env, clamped to a sane [0,1] range. */
export function similarityThreshold(): number {
  const raw = Number(process.env.LLM_CACHE_SIMILARITY_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_SIMILARITY_THRESHOLD;
  return raw;
}

export interface LlmCacheDeps {
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
}

const defaultDeps: LlmCacheDeps = {
  isCosmosConfigured: isConfigured,
  embed: foundryEmbed,
  vectorSearch: vectorSearchDocs,
  upsert: upsertDoc,
};

export interface LlmCacheEntry {
  output: string;
  model: string;
  usage?: unknown;
}

interface CacheDoc {
  id: string;
  cacheScope: string;
  prompt: string;
  queryVector: number[];
  entry: LlmCacheEntry;
  ts: string;
  ttl: number;
}

/**
 * Build the cache partition key. Bakes in everything besides the raw prompt text that could
 * change the correct answer: the caller's own agent lane (so lanes never share entries), the
 * task type (summarize/classify/extract/synthesize/complete), and the resolved tier/deployment.
 */
export function scopeFor(callerAgent: string, task: string, tier: string): string {
  return `llm:${callerAgent}:${task}:${tier}`;
}

/** Is this (lane, mode, cosmos-configured) combination eligible for the cache at all? Pure. */
export function cacheEligible(callerAgent: string, deps: Pick<LlmCacheDeps, 'isCosmosConfigured'> = defaultDeps): boolean {
  const lane = (callerAgent || '').trim().toLowerCase();
  if (cacheMode() !== 'on') return false;
  if (lane === '' || lane === NEVER_CACHE_LANE) return false;
  return deps.isCosmosConfigured();
}

export interface CacheLookupResult {
  hit: boolean;
  entry?: LlmCacheEntry;
  similarity?: number;
}

/**
 * Cache-check BEFORE the LLM call. Returns hit:false on ANY failure (fail-open) so the caller
 * always falls through to a normal chat() call. Never throws.
 */
export async function checkLlmCache(
  prompt: string,
  callerAgent: string,
  task: string,
  tier: string,
  opts?: { threshold?: number; deps?: Partial<LlmCacheDeps> },
): Promise<CacheLookupResult> {
  const deps: LlmCacheDeps = { ...defaultDeps, ...opts?.deps };
  if (!cacheEligible(callerAgent, deps)) return { hit: false };
  const threshold = opts?.threshold ?? similarityThreshold();
  try {
    const vector = await deps.embed(prompt);
    if (!vector) return { hit: false };
    const scope = scopeFor(callerAgent, task, tier);
    const matches = await deps.vectorSearch(CACHE_CONTAINER, scope, VECTOR_FIELD, vector, 1);
    const top = matches[0];
    if (!top || top.similarity < threshold) return { hit: false };
    const doc = top.doc as unknown as CacheDoc;
    if (!doc || !doc.entry || typeof doc.entry.output !== 'string') return { hit: false };
    return { hit: true, entry: doc.entry, similarity: top.similarity };
  } catch {
    return { hit: false }; // fail-open: any Cosmos/Foundry error just means "no cache hit"
  }
}

/**
 * Best-effort write-back after a fresh LLM call. Never throws; callers should fire-and-forget
 * (`void writeLlmCache(...).catch(() => undefined)`) exactly like memory/hot-cache.ts does.
 */
export async function writeLlmCache(
  prompt: string,
  callerAgent: string,
  task: string,
  tier: string,
  entry: LlmCacheEntry,
  opts?: { deps?: Partial<LlmCacheDeps> },
): Promise<void> {
  const deps: LlmCacheDeps = { ...defaultDeps, ...opts?.deps };
  if (!cacheEligible(callerAgent, deps)) return;
  try {
    const vector = await deps.embed(prompt);
    if (!vector) return;
    const scope = scopeFor(callerAgent, task, tier);
    const doc: CacheDoc = {
      id: newId('llmcache'),
      cacheScope: scope,
      prompt,
      queryVector: vector,
      entry,
      ts: new Date().toISOString(),
      ttl: CACHE_TTL_SECONDS,
    };
    await deps.upsert(CACHE_CONTAINER, scope, doc as unknown as Record<string, unknown>);
  } catch {
    /* best-effort; a cache-write failure must never surface to the caller */
  }
}
