/**
 * Azure AI Foundry (otchealth-foundry, kind AIServices) client — the credit-funded
 * OpenAI-family endpoint. Two uses across the gateway:
 *   - embed(text):  text-embedding-3-large -> query vector for HYBRID AI Search.
 *   - chat(...):    gpt-4.1-mini -> the llm_cheap commodity path (the FLEET COST PROTOCOL
 *                   escape hatch: route summarize/classify/extract/synthesize off metered
 *                   Claude tokens onto Azure credits).
 *
 * Env (read via loadEnv; inert when unset):
 *   FOUNDRY_OPENAI_ENDPOINT  e.g. https://otchealth-foundry.openai.azure.com  (or .cognitiveservices.azure.com)
 *   FOUNDRY_KEY              data-plane key
 *   FOUNDRY_CHAT_DEPLOYMENT  default 'gpt-4.1-mini'
 *   FOUNDRY_EMBED_DEPLOYMENT default 'text-embedding-3-large'
 */
import { createHash } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const API_VERSION = '2024-08-01-preview';

function cfg(): { ep: string; key: string; chat: string; high: string; embed: string } | null {
  const e = loadEnv();
  const ep = (e.FOUNDRY_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  const key = e.FOUNDRY_KEY || '';
  if (!ep || !key) return null;
  return {
    ep,
    key,
    // standard = gpt-5.1 (good); high = gpt-5.4 (strongest deployed). gpt-4.1-mini is BANNED for
    // quality work (it failed the doc-repo summarization). gpt-5.5 pending a quota increase.
    chat: e.FOUNDRY_CHAT_DEPLOYMENT || 'gpt-5.1',
    high: e.FOUNDRY_HIGH_DEPLOYMENT || e.FOUNDRY_CHAT_DEPLOYMENT || 'gpt-5.4',
    embed: e.FOUNDRY_EMBED_DEPLOYMENT || 'text-embedding-3-large',
  };
}

/** Resolve a tier label to a deployment name. */
export function deploymentForTier(tier?: 'standard' | 'high'): string | null {
  const c = cfg();
  if (!c) return null;
  return tier === 'high' ? c.high : c.chat;
}

export function foundryConfigured(): boolean {
  return cfg() !== null;
}

export class FoundryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FoundryError';
    this.status = status;
  }
}

// Bounded + one retry: Foundry chat/embeddings calls are read-only inference requests (no
// server-side state mutated by re-sending the same prompt/input), safe to repeat once on a
// network blip / 429 / 5xx (see src/util/fetch-budget.ts). The retry is fully contained inside
// fetchWithBudget; postEmbeddings/postChat below still see exactly one final Response each and
// preserve their existing error shape (FoundryError with the LAST observed status) whether or not
// a retry happened.
/**
 * ================== EMBEDDINGS PROVIDER (the Azure-exit escape hatch) ==================
 *
 * Vector search embeds EVERY query here, so as long as this points at Azure Foundry, the brain
 * cannot survive an Azure suspension no matter where the search engine or the documents live. This
 * was the last runtime dependency in the read path.
 *
 * THE CONSTRAINT THAT DECIDES THE PROVIDER: an index's vectors are only comparable to query vectors
 * from THE SAME MODEL. The 492,557 documents in OpenSearch were embedded with text-embedding-3-large
 * at 3072 dimensions. Point queries at a different model -- AWS Bedrock Titan or Cohere, the
 * "obvious" AWS-native choice -- and every similarity score becomes meaningless. It does not error;
 * relevance just quietly collapses, and the only repair is re-embedding all 492k documents.
 *
 * OpenAI's own API serves the IDENTICAL text-embedding-3-large. So switching Azure OpenAI ->
 * OpenAI-direct keeps the exact vector space and needs no re-embedding at all: it is a change of
 * URL and auth header, not a migration. That is why this is a provider branch rather than a project.
 *
 *   EMBEDDINGS_PROVIDER=foundry  (default)  Azure Foundry. Byte-identical to every prior deploy.
 *   EMBEDDINGS_PROVIDER=openai              api.openai.com, same model, same vectors.
 *
 * Deliberately NOT sending a `dimensions` parameter on either path: text-embedding-3-large returns
 * 3072 natively, and passing `dimensions` would truncate the vector into a space the index does not
 * share -- the same silent-relevance-collapse failure by a different route.
 */
export interface EmbeddingsTarget {
  url: string;
  headers: Record<string, string>;
  /** Body field naming differs: Azure addresses the model by URL deployment, OpenAI by `model`. */
  model: string | null;
}

export function embeddingsTarget(): EmbeddingsTarget | null {
  const e = loadEnv();
  if (e.EMBEDDINGS_PROVIDER === 'openai') {
    const key = e.OPENAI_API_KEY || '';
    if (!key) return null;
    return {
      url: 'https://api.openai.com/v1/embeddings',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      // Pinned, not configurable: it MUST match the model the index was built with.
      model: 'text-embedding-3-large',
    };
  }
  const c = cfg();
  if (!c) return null;
  return {
    url: `${c.ep}/openai/deployments/${c.embed}/embeddings?api-version=${API_VERSION}`,
    headers: { 'Content-Type': 'application/json', 'api-key': c.key },
    model: null,
  };
}

/** POST to a fully-formed embeddings target. Shares post()'s error shape so callers are unchanged. */
async function postEmbeddings<T>(target: EmbeddingsTarget, body: Record<string, unknown>): Promise<T> {
  const payload = target.model ? { ...body, model: target.model } : body;
  const res = await fetchWithBudget(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (res.status >= 400) {
    const msg = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new FoundryError(res.status, msg);
  }
  return data as T;
}

/** Embed a single string with text-embedding-3-large. Returns the vector, or null when unconfigured. */
export async function embed(text: string): Promise<number[] | null> {
  const target = embeddingsTarget();
  if (!target) return null;
  const j = await postEmbeddings<{ data?: Array<{ embedding: number[] }> }>(target, { input: text });
  return j.data?.[0]?.embedding ?? null;
}

/**
 * Embed a batch of strings in ONE call (Azure OpenAI's /embeddings endpoint accepts an array
 * `input`). Returns vectors in the SAME ORDER as `texts`. Azure guarantees `data[i].index === i`
 * matching the input order, but this sorts by `.index` defensively rather than trusting bare
 * array order, so a caller can always do `vector[i]` <-> `texts[i]` safely.
 *
 * Returns null when unconfigured (mirrors `embed`) or when the input list is empty. On any
 * failure this throws (same as `embed`/`post`); callers that want a same-shape-as-embed
 * best-effort fallback should catch and fall back to per-item `embed()` calls, exactly as the
 * existing per-call `embed()` sites already do.
 */
export async function embedBatch(texts: string[]): Promise<number[][] | null> {
  const target = embeddingsTarget();
  if (!target) return null;
  if (texts.length === 0) return [];
  const j = await postEmbeddings<{ data?: Array<{ embedding: number[]; index?: number }> }>(target, {
    input: texts,
  });
  const data = j.data ?? [];
  return [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((d) => d.embedding);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Stable cache-affinity key for Azure OpenAI automatic prompt caching. Azure caches identical
 * request prefixes (>=1024 tokens) automatically; passing a CONSISTENT `user` value routes repeat
 * calls that share the same stable prefix to the same cache node, materially improving the cache-hit
 * rate. We derive the key from the deployment + the SYSTEM messages only (the stable prefix), and
 * deliberately exclude the variable user content so the key stays constant across calls that share a
 * system prompt (e.g. every groundedness check, every llm_azure summarize). `user` is a long-standing,
 * optional Azure OpenAI field that is safely ignored where unsupported (never a 400), so this is a
 * zero-risk routing hint, not a behavior change. Pure + deterministic (unit-tested).
 */
export function promptCacheKey(deployment: string, messages: ChatMessage[]): string {
  const prefix = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return 'oc-' + createHash('sha256').update(`${deployment}\n${prefix}`).digest('hex').slice(0, 24);
}

/** Is the Azure Model Router configured? */
export function routerConfigured(): boolean {
  const e = loadEnv();
  return Boolean(e.FOUNDRY_ROUTER_ENDPOINT && e.FOUNDRY_ROUTER_KEY);
}

/**
 * ================== CHAT PROVIDER (the second Azure-exit escape hatch) ==================
 *
 * The counterpart to embeddingsTarget() above, but for CHAT completions rather than embeddings --
 * the other live Azure inference dependency. Every chat() caller in the gateway (llm_azure,
 * deep-retrieval's plan/refine/synthesis, checkpoint's summary distillation, claims-check's
 * compliance verdicts, auto-supersede's contradiction classifier) goes through this ONE function, so
 * routing chat() itself through a provider switch moves every caller at once, with none of them
 * needing to change.
 *
 * UNLIKE embeddings, there is no shared-vector-space constraint here: a chat completion is never
 * compared against a precomputed store, so a provider switch cannot silently corrupt an index the
 * way a wrong embedding model would. The risk here is narrower and different: MODEL EQUIVALENCE.
 *
 *   LLM_PROVIDER=foundry (default)  Azure Foundry. Byte-identical to every prior deploy.
 *   LLM_PROVIDER=openai             api.openai.com, using OPENAI_API_KEY (already present above).
 *
 * THE TIER MAPPING (read before flipping this -- see the LLM_PROVIDER env comment for the summary):
 *   'standard' -> OPENAI_CHAT_MODEL (default 'gpt-5.1')
 *   'high'     -> OPENAI_HIGH_MODEL (default 'gpt-5.4')
 *  These defaults treat FOUNDRY_CHAT_DEPLOYMENT/FOUNDRY_HIGH_DEPLOYMENT as the REAL underlying model
 *  ids, not arbitrary Azure deployment labels -- the SAME assumption the embeddings path already
 *  relies on for text-embedding-3-large (FOUNDRY_EMBED_DEPLOYMENT's value is sent verbatim as the
 *  literal OpenAI `model` field in embeddingsTarget() above). That precedent is why the default
 *  mapping is a same-model swap of endpoint + auth rather than an invented substitute. It has NOT,
 *  however, been independently verified the way the embeddings model was (a live cosine-similarity
 *  check proved the SAME vector space on both providers); no equivalent check exists for chat output
 *  quality. Confirm the model ids are actually callable on api.openai.com, and spot-check output
 *  quality, before trusting cost/quality parity after a flip.
 *
 *   'router'   -> NO CLEAN EQUIVALENT. The Azure Model Router (FOUNDRY_ROUTER_DEPLOYMENT) is an
 *  Azure-only product: a proxy that dynamically picks the cheapest-sufficient backing model per
 *  request. OpenAI's public API has no matching endpoint or concept, so chatTarget() does not invent
 *  one. Instead it reuses THIS FILE'S OWN pre-existing "router not configured" fallback -- drop to
 *  the 'standard' model -- the exact fallback chat() already applied before this change whenever
 *  FOUNDRY_ROUTER_ENDPOINT/KEY were unset, regardless of provider. On LLM_PROVIDER=openai that
 *  fallback is unconditional (there is no OpenAI router to ever "become configured"). This is a
 *  judgement call, not a proven equivalence -- flag it to the CTO rather than treating router-tier
 *  cost/quality behavior as settled after a flip.
 *
 * OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL are configurable (unlike the pinned embeddings model): a chat
 * model swap cannot silently corrupt anything the way an embedding model swap can, so there is no
 * reason to hard-pin it in code the way text-embedding-3-large is pinned above.
 */
export interface ChatTarget {
  url: string;
  headers: Record<string, string>;
  /** Body field naming differs: Azure addresses the model by URL deployment, OpenAI by `model`. */
  model: string | null;
  /**
   * The resolved model/deployment NAME on either path. Always populated (unlike `model`, which is
   * body-only and null on the Azure path) -- used for the chat() response's `model` fallback and
   * for the cache-affinity key, so a caller can always identify what was actually targeted.
   */
  resolvedName: string;
}

/**
 * Resolve WHERE a chat() call for the given tier should go, honouring LLM_PROVIDER. Mirrors
 * embeddingsTarget()'s shape and fail-open discipline: returns null when the active provider is
 * unconfigured (missing endpoint/key), never throws.
 */
export function chatTarget(opts?: { tier?: 'standard' | 'high' | 'router'; deployment?: string }): ChatTarget | null {
  const e = loadEnv();
  const tier = opts?.tier;
  if (e.LLM_PROVIDER === 'openai') {
    const key = e.OPENAI_API_KEY || '';
    if (!key) return null;
    // No OpenAI equivalent for 'router' (see the section comment above) -- every tier here resolves
    // to a concrete model, so an explicit opts.deployment override always applies. This differs from
    // the Azure branch below, where the router step can still supersede an opts.deployment override
    // once the router is reachable (pre-existing behavior, preserved as-is for that path).
    const model = opts?.deployment || (tier === 'high' ? e.OPENAI_HIGH_MODEL : e.OPENAI_CHAT_MODEL);
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      model,
      resolvedName: model,
    };
  }
  const c = cfg();
  if (!c) return null;
  // Verbatim pre-existing Azure resolution, moved here unchanged from chat() so the default
  // (LLM_PROVIDER=foundry) path is byte-identical to every prior deploy. 'router' uses the Azure
  // Model Router (auto-picks the cheapest-sufficient model); falls back to Foundry standard if the
  // router isn't configured.
  let ep = c.ep, key = c.key, deployment = opts?.deployment || (tier === 'high' ? c.high : c.chat);
  if (tier === 'router') {
    if (e.FOUNDRY_ROUTER_ENDPOINT && e.FOUNDRY_ROUTER_KEY) {
      ep = e.FOUNDRY_ROUTER_ENDPOINT.replace(/\/+$/, '');
      key = e.FOUNDRY_ROUTER_KEY;
      deployment = e.FOUNDRY_ROUTER_DEPLOYMENT || 'model-router';
    }
  }
  return {
    url: `${ep}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`,
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    model: null,
    resolvedName: deployment,
  };
}

/** POST to a fully-formed chat target. Mirrors postEmbeddings's shape/error handling exactly. */
async function postChat<T>(target: ChatTarget, body: Record<string, unknown>): Promise<T> {
  const payload = target.model ? { ...body, model: target.model } : body;
  const res = await fetchWithBudget(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (res.status >= 400) {
    const msg = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new FoundryError(res.status, msg);
  }
  return data as T;
}

/**
 * Chat completion, on whichever provider LLM_PROVIDER selects (see the section comment above):
 * Foundry (default gpt-5.1 standard / gpt-5.4 high, or the Model Router) or OpenAI-direct. Callers
 * are unaffected by which provider is active -- same signature, same return shape, same errors.
 * Non-streaming (a single awaited fetch -> full JSON body): callers can time the whole call
 * wall-clock (duration_ms), but can never derive a genuine time-to-first-token from this path. See
 * telemetry/gateway-ops.ts buildLatencyFields, which omits ttft_ms rather than faking it for
 * exactly this reason.
 */
export async function chat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean; deployment?: string; tier?: 'standard' | 'high' | 'router'; cacheKey?: string },
): Promise<{ text: string; usage?: unknown; model: string }> {
  const target = chatTarget({ tier: opts?.tier, deployment: opts?.deployment });
  if (!target) {
    const e = loadEnv();
    throw new FoundryError(
      0,
      e.LLM_PROVIDER === 'openai'
        ? 'OpenAI chat not configured (OPENAI_API_KEY unset)'
        : 'Foundry not configured (FOUNDRY_OPENAI_ENDPOINT/FOUNDRY_KEY unset)',
    );
  }
  // gpt-5 / o-series reasoning models require max_completion_tokens (not max_tokens) and reject a
  // custom temperature (only the default is allowed). Use the new param and only pass temperature
  // when a caller explicitly sets it (kept for older gpt-4.x deployments, and for whatever model
  // OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL name on the OpenAI path).
  const body: Record<string, unknown> = {
    messages,
    max_completion_tokens: opts?.maxTokens ?? 1024,
  };
  if (typeof opts?.temperature === 'number') body.temperature = opts.temperature;
  if (opts?.jsonMode) body.response_format = { type: 'json_object' };
  // Cache-affinity routing for Azure OpenAI automatic prompt caching (see promptCacheKey). Additive
  // and safe on both providers: `user` is ignored where unsupported and never changes the completion.
  body.user = opts?.cacheKey || promptCacheKey(target.resolvedName, messages);
  const j = await postChat<{ choices?: Array<{ message?: { content?: string } }>; usage?: unknown; model?: string }>(target, body);
  // The router (or the API) echoes which underlying model actually answered in `model`; surface
  // that, falling back to the resolved name (Azure deployment or OpenAI model id) when it is absent.
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage, model: j.model || target.resolvedName };
}
