/**
 * Azure AI Foundry (otchealth-foundry, kind AIServices) client — originally the credit-funded
 * OpenAI-family endpoint, now ONE of two interchangeable providers behind two independent switches:
 *   - embed(text)/embedBatch(texts): text-embedding-3-large -> query vector(s) for HYBRID AI Search.
 *     Provider chosen by EMBEDDINGS_PROVIDER; see embeddingsTarget()'s header for why the model is
 *     pinned identical across providers (a 492,557-doc index depends on it).
 *   - chat(...): summarize/classify/extract/synthesize/complete -- the FLEET COST PROTOCOL escape
 *     hatch (route commodity LLM work off metered Claude tokens). Provider chosen by LLM_PROVIDER;
 *     see chatTarget()'s header for the tier -> model mapping and its open judgement calls.
 *
 * Env (read via loadEnv; inert when unset):
 *   FOUNDRY_OPENAI_ENDPOINT  e.g. https://otchealth-foundry.openai.azure.com  (or .cognitiveservices.azure.com)
 *   FOUNDRY_KEY              data-plane key
 *   FOUNDRY_CHAT_DEPLOYMENT  default 'gpt-5.1'
 *   FOUNDRY_HIGH_DEPLOYMENT  default 'gpt-5.4'
 *   FOUNDRY_EMBED_DEPLOYMENT default 'text-embedding-3-large'
 *   LLM_PROVIDER             foundry (default) | openai -- see chatTarget() below
 *   EMBEDDINGS_PROVIDER      foundry (default) | openai -- see embeddingsTarget() below
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

// Bounded + one retry: chat/embeddings calls (either provider) are read-only inference requests
// (no server-side state mutated by re-sending the same prompt/input), safe to repeat once on a
// network blip / 429 / 5xx (see src/util/fetch-budget.ts). The retry is fully contained inside
// fetchWithBudget; postToTarget() below still sees exactly one final Response and preserves its
// existing error shape (FoundryError with the LAST observed status) whether or not a retry happened.
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
/** Shared shape for any {url, headers, model} provider target -- embeddings and chat both resolve
 *  to this, so the POST plumbing (postToTarget below) is written once. */
interface ProviderTarget {
  url: string;
  headers: Record<string, string>;
  /** Body field naming differs: Azure addresses the model by URL deployment, OpenAI by `model`. */
  model: string | null;
}

export interface EmbeddingsTarget extends ProviderTarget {}

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

/**
 * ================== CHAT PROVIDER (the Azure-exit escape hatch, chat side) ==================
 *
 * Mirrors embeddingsTarget() above exactly in shape and fail-open discipline, gated by its OWN
 * flag (LLM_PROVIDER, not EMBEDDINGS_PROVIDER) so chat and embeddings can move independently.
 *
 *   LLM_PROVIDER=foundry  (default)  Azure Foundry. Byte-identical to every prior deploy.
 *   LLM_PROVIDER=openai              api.openai.com, using OPENAI_API_KEY.
 *
 * MODEL-EQUIVALENCE IS A REAL RISK HERE, UNLIKE THE EMBEDDINGS PATH ABOVE. Embeddings are safe to
 * default identically across providers because text-embedding-3-large is verifiably the SAME model
 * on both (confirmed live 2026-08-15, cosine similarity 0.99999791 between the two -- see
 * embeddings-provider.test.ts). Chat has no such proof: FOUNDRY_CHAT_DEPLOYMENT/
 * FOUNDRY_HIGH_DEPLOYMENT ('gpt-5.1'/'gpt-5.4') are AZURE DEPLOYMENT NAMES -- an operator-chosen
 * alias for whatever underlying model was deployed under it -- not necessarily a real, callable
 * api.openai.com model id. Defaulting OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL to those SAME strings
 * (see openaiModelForTier below) is a documented JUDGEMENT CALL: a bet that the operator named the
 * Azure deployment after its real underlying model, which is a common but not universal Azure
 * OpenAI convention. This code has no way to verify that bet from inside the gateway. If it is
 * wrong, api.openai.com returns a fast, loud 404 model_not_found -- never a silently-wrong answer
 * from the wrong model -- so an incorrect guess fails safely; it does not corrupt anything the way
 * a wrong embeddings model would. Override OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL the moment the real
 * ids are confirmed.
 *
 * tier:'router' (Azure Model Router, a PRODUCT that auto-picks the cheapest-sufficient underlying
 * model per request) has NO documented api.openai.com counterpart at all. Rather than invent one,
 * the OpenAI path makes tier:'router' fall back to the SAME model as tier:'standard' -- this is not
 * a guess dressed as a feature, it is the IDENTICAL fallback chat() already performs today when
 * FOUNDRY_ROUTER_ENDPOINT/KEY are unset (see the tier==='router' branch below). LLM_PROVIDER=openai
 * simply behaves as if the router were permanently unconfigured. OPENAI_ROUTER_MODEL overrides this
 * if a real OpenAI routing model id is confirmed later.
 */
export interface ChatTarget extends ProviderTarget {
  /** The resolved deployment name (Foundry) or model id (OpenAI), for cache-key derivation and as
   *  the reported `model` when the API response does not echo one back. */
  resolvedLabel: string;
}

const OPENAI_CHAT_API_URL = 'https://api.openai.com/v1/chat/completions';

/** Tier -> OpenAI-direct model id. See this section's header for why these defaults are a
 *  judgement call, not a verified fact, and why 'router' collapses to 'standard'. Mirrors cfg()'s
 *  own chat/high fallback chain above exactly (high falls back to the STANDARD model before the
 *  hardcoded literal, same as FOUNDRY_HIGH_DEPLOYMENT falls back to FOUNDRY_CHAT_DEPLOYMENT) --
 *  the hardcoded high-tier literal is 'gpt-5.4', NOT 'gpt-5.1', or a caller asking for tier:'high'
 *  with neither override set would silently get the standard-tier model instead. */
function openaiModelForTier(e: ReturnType<typeof loadEnv>, tier?: 'standard' | 'high' | 'router'): string {
  if (tier === 'high') return e.OPENAI_HIGH_MODEL || e.OPENAI_CHAT_MODEL || 'gpt-5.4';
  if (tier === 'router') return e.OPENAI_ROUTER_MODEL || e.OPENAI_CHAT_MODEL || 'gpt-5.1';
  return e.OPENAI_CHAT_MODEL || 'gpt-5.1';
}

/**
 * Resolve where a chat() call should go: URL, headers, and the model/deployment to use, for the
 * ACTIVE provider (LLM_PROVIDER) and the requested tier. `deploymentOverride` (chat()'s `deployment`
 * opt) forces an exact deployment name (Foundry) or model id (OpenAI) regardless of tier, mirroring
 * the pre-existing override behaviour byte-for-byte on the Foundry path.
 */
export function chatTarget(
  tier?: 'standard' | 'high' | 'router',
  deploymentOverride?: string,
): ChatTarget | null {
  const e = loadEnv();
  if (e.LLM_PROVIDER === 'openai') {
    const key = e.OPENAI_API_KEY || '';
    if (!key) return null;
    const model = deploymentOverride || openaiModelForTier(e, tier);
    return {
      url: OPENAI_CHAT_API_URL,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      model,
      resolvedLabel: model,
    };
  }
  const c = cfg();
  if (!c) return null;
  // Resolve endpoint/key/deployment by tier. 'router' uses the Azure Model Router (auto-picks the
  // cheapest-sufficient model); falls back to Foundry standard if the router isn't configured --
  // BYTE-IDENTICAL to chat()'s pre-existing resolution order.
  let ep = c.ep, key = c.key, deployment = deploymentOverride || (tier === 'high' ? c.high : c.chat);
  if (tier === 'router') {
    if (e.FOUNDRY_ROUTER_ENDPOINT && e.FOUNDRY_ROUTER_KEY) {
      ep = e.FOUNDRY_ROUTER_ENDPOINT.replace(/\/+$/, '');
      key = e.FOUNDRY_ROUTER_KEY;
      deployment = deploymentOverride || e.FOUNDRY_ROUTER_DEPLOYMENT || 'model-router';
    }
  }
  return {
    url: `${ep}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`,
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    model: null,
    resolvedLabel: deployment,
  };
}

/** Is a chat() call currently reachable, for the ACTIVE provider? Provider-aware replacement for
 *  gating chat() calls -- foundryConfigured() above stays literally "is Foundry itself reachable"
 *  (still used by nothing outside this provider-selection logic today), while every caller that
 *  gates a chat() call should use this instead so LLM_PROVIDER=openai is recognised correctly. */
export function chatConfigured(): boolean {
  return chatTarget() !== null;
}

/** Shared POST helper for any resolved {url, headers, model} provider target (embeddings or chat).
 *  Sends `model` in the body only when the target declares one (OpenAI addresses the model in the
 *  body; Azure already baked its deployment into `target.url`, so `model` stays null there). */
async function postToTarget<T>(target: ProviderTarget, body: Record<string, unknown>): Promise<T> {
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

/** POST to a fully-formed embeddings target. Kept as a thin named wrapper (rather than calling
 *  postToTarget directly at each call site) so embed()/embedBatch() below read exactly as they did
 *  before this refactor. */
async function postEmbeddings<T>(target: EmbeddingsTarget, body: Record<string, unknown>): Promise<T> {
  return postToTarget<T>(target, body);
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
 * Chat completion on the ACTIVE provider (LLM_PROVIDER: a credit-funded Foundry deployment, default
 * gpt-5.1, the Model Router; or api.openai.com when LLM_PROVIDER=openai). URL/headers/model
 * resolution lives entirely in chatTarget() above -- this function no longer knows which provider
 * it is talking to, which is what makes LLM_PROVIDER a genuine switch rather than a partial one.
 * Non-streaming (a single awaited fetch -> full JSON body): callers can time the whole call
 * wall-clock (duration_ms), but can never derive a genuine time-to-first-token from this path. See
 * telemetry/gateway-ops.ts buildLatencyFields, which omits ttft_ms rather than faking it for
 * exactly this reason.
 */
export async function chat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean; deployment?: string; tier?: 'standard' | 'high' | 'router'; cacheKey?: string },
): Promise<{ text: string; usage?: unknown; model: string }> {
  const target = chatTarget(opts?.tier, opts?.deployment);
  if (!target) {
    const e = loadEnv();
    throw new FoundryError(
      0,
      e.LLM_PROVIDER === 'openai'
        ? 'Chat unconfigured (LLM_PROVIDER=openai but OPENAI_API_KEY unset)'
        : 'Foundry not configured (FOUNDRY_OPENAI_ENDPOINT/FOUNDRY_KEY unset)',
    );
  }
  // gpt-5 / o-series reasoning models require max_completion_tokens (not max_tokens) and reject a
  // custom temperature (only the default is allowed). Use the new param and only pass temperature
  // when a caller explicitly sets it (kept for older gpt-4.x deployments). Both Azure OpenAI and
  // OpenAI-direct speak the same Chat Completions body shape (Azure OpenAI mirrors OpenAI's own
  // REST API for whatever model family is deployed), so this body is NOT provider-branched.
  const body: Record<string, unknown> = {
    messages,
    max_completion_tokens: opts?.maxTokens ?? 1024,
  };
  if (typeof opts?.temperature === 'number') body.temperature = opts.temperature;
  if (opts?.jsonMode) body.response_format = { type: 'json_object' };
  // Cache-affinity routing for Azure OpenAI automatic prompt caching (see promptCacheKey). Additive
  // and safe: `user` is ignored where unsupported (incl. by OpenAI-direct) and never changes the
  // completion.
  body.user = opts?.cacheKey || promptCacheKey(target.resolvedLabel, messages);
  const j = await postToTarget<{ choices?: Array<{ message?: { content?: string } }>; usage?: unknown; model?: string }>(target, body);
  // The API echoes which underlying model actually answered (the Azure Model Router in particular
  // picks one per request); surface that, falling back to the resolved deployment/model label.
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage, model: j.model || target.resolvedLabel };
}
