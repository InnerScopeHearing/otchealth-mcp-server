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
import { recordOpenAIUsage } from '../telemetry/openai-cost.js';

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
 * MODEL DEFAULTS (CORRECTED 2026-09-03): OPENAI_CHAT_MODEL/OPENAI_HIGH_MODEL/OPENAI_ROUTER_MODEL
 * now default to the confirmed-live gpt-5.6 family -- terra (standard), sol (high/quality), luna
 * (router/cheap); see openaiModelForTier() below and src/telemetry/openai-cost.ts's price table
 * (same three names, same date). This supersedes the PRIOR 'gpt-5.1'/'gpt-5.4' defaults, which were
 * a documented judgement call rather than a verified fact: a bet that the operator had named the
 * Azure Foundry deployment after its real underlying model, which is a common but not universal
 * Azure OpenAI convention, with no way for this code to verify it. That bet is UNCHANGED and still
 * exactly describes FOUNDRY_CHAT_DEPLOYMENT/FOUNDRY_HIGH_DEPLOYMENT on the Foundry branch above
 * (cfg(), still 'gpt-5.1'/'gpt-5.4') -- only the OpenAI-direct branch's own defaults move here,
 * because gpt-5.6-{terra,sol,luna} are real api.openai.com model ids, confirmed reachable directly,
 * not an alias inherited from an unrelated Azure deployment name. OPENAI_CHAT_MODEL/
 * OPENAI_HIGH_MODEL/OPENAI_ROUTER_MODEL still override these at any time (e.g. once a newer family
 * ships), and a wrong id still fails fast and loud -- api.openai.com's 404 model_not_found, never a
 * silently-wrong answer from the wrong model.
 *
 * tier:'router' (Azure Model Router, a PRODUCT that auto-picks the cheapest-sufficient underlying
 * model per request) still has no literal api.openai.com PRODUCT equivalent, but the gpt-5.6 family
 * gives the OpenAI-direct path a real answer to the question the router exists to answer -- "the
 * cheapest model still sufficient for this request" -- for the first time: gpt-5.6-luna. So
 * tier:'router' now defaults to luna DIRECTLY, rather than collapsing to the standard-tier model the
 * way it did back when no confirmed OpenAI-direct model was cheap enough to justify its own default
 * (see openaiModelForTier() below; this is a genuine behavior change for the fully-unconfigured
 * case, not just a literal-string swap). OPENAI_CHAT_MODEL still cascades into an unset
 * OPENAI_ROUTER_MODEL before the luna default -- mirroring the identical OPENAI_HIGH_MODEL /
 * OPENAI_CHAT_MODEL cascade tier:'high' already used -- so an operator who has set ONLY
 * OPENAI_CHAT_MODEL still gets that one override applied uniformly across every tier, exactly as
 * before this change. OPENAI_ROUTER_MODEL overrides the luna default outright once a dedicated
 * OpenAI routing product id exists.
 */
export interface ChatTarget extends ProviderTarget {
  /** The resolved deployment name (Foundry) or model id (OpenAI), for cache-key derivation and as
   *  the reported `model` when the API response does not echo one back. */
  resolvedLabel: string;
}

const OPENAI_CHAT_API_URL = 'https://api.openai.com/v1/chat/completions';

/** Tier -> OpenAI-direct model id, defaulting to the gpt-5.6 family (verified live 2026-09-03):
 *  terra (standard), sol (high/quality), luna (router/cheap) -- see this section's header above for
 *  the full reasoning, including why 'router' gets luna as its OWN default rather than collapsing
 *  to 'standard' the way it used to. Mirrors cfg()'s own chat/high fallback shape: high AND router
 *  both fall back through OPENAI_CHAT_MODEL before their own literal (the same cascade
 *  FOUNDRY_HIGH_DEPLOYMENT uses for FOUNDRY_CHAT_DEPLOYMENT), so an operator who has set only
 *  OPENAI_CHAT_MODEL still gets it applied to every tier. The hardcoded high-tier literal is
 *  'gpt-5.6-sol' and router's is 'gpt-5.6-luna' -- NEITHER is 'gpt-5.6-terra' -- or a caller asking
 *  for tier:'high'/'router' with nothing overridden would silently get the standard-tier model
 *  instead. */
function openaiModelForTier(e: ReturnType<typeof loadEnv>, tier?: 'standard' | 'high' | 'router'): string {
  if (tier === 'high') return e.OPENAI_HIGH_MODEL || e.OPENAI_CHAT_MODEL || 'gpt-5.6-sol';
  if (tier === 'router') return e.OPENAI_ROUTER_MODEL || e.OPENAI_CHAT_MODEL || 'gpt-5.6-luna';
  return e.OPENAI_CHAT_MODEL || 'gpt-5.6-terra';
}

/**
 * Models that reject ANY non-default `temperature` outright -- api.openai.com answers HTTP 400
 * "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1)
 * value is supported." LIVE-VERIFIED 2026-09-03 from the CTO seat: gpt-5.6-luna and gpt-5.6-terra
 * reject temperature 0; gpt-5.1 and gpt-5.4 ACCEPT it (HTTP 200). So the gate is exactly the
 * gpt-5.6 family, NOT "every gpt-5 model": widening it would silently change the sampling of the
 * gpt-5.1/5.4 callers that rely on temperature 0 today (src/memory/auto-supersede-runtime.ts passes
 * temperature 0 on tier:'router'), and narrowing it would 400 every such call the moment the
 * gpt-5.6 defaults above (or an OPENAI_*_MODEL env pointing at them) take effect. chat() below
 * simply omits `temperature` for these models, the same way the toolkit's chatBody() drops it for
 * reasoning-family deployments; callers keep their own temperature for every other model. Extend
 * the pattern only after a live probe proves a new family rejects the parameter too.
 */
/** True for any model in the gpt-5.6 family (terra/sol/luna, or any dated variant of them) --
 *  the single family-membership test shared by every gpt-5.6-specific behavior in this file:
 *  rejectsTemperature() below, and chat()'s router-tier reasoning_effort default (see chat()'s own
 *  opts.reasoningEffort doc comment). Kept as one regex so the family boundary is never updated in
 *  two places. */
function isGpt56Family(model: string): boolean {
  return /^gpt-5\.6-/i.test(String(model || ''));
}

export function rejectsTemperature(model: string): boolean {
  return isGpt56Family(model);
}

/**
 * OpenAI (and Azure OpenAI) REJECT `response_format: { type: 'json_object' }` unless at least one
 * message contains the word "json": HTTP 400 "'messages' must contain the word 'json' in some form,
 * to use 'response_format' of type 'json_object'". Live-verified 2026-09-03 on the rev-39 gateway:
 * llm_azure task=classify with jsonMode=true failed on ALL three tiers (terra/sol/luna) because the
 * classify system prompt only said "Reply with only the label." -- while extract ("Reply with JSON
 * only.") and every other in-repo jsonMode caller (auto-supersede, checkpoint, deep-retrieval
 * plan/refine, claims-check) already say JSON and were fine. Guarded HERE, at the single request
 * builder, so no present or future caller can hit the rule again: when jsonMode is on and no message
 * mentions json, ONE trailing system line is appended. Additive only -- prompts that already mention
 * JSON come back untouched (same array identity), and jsonMode off is a no-op.
 */
export const JSON_MODE_NUDGE = 'Respond with a single valid JSON object and nothing else.';
export function ensureJsonModeMessages(messages: ChatMessage[], jsonMode: boolean | undefined): ChatMessage[] {
  if (!jsonMode) return messages;
  const mentionsJson = messages.some((m) => /json/i.test(String(m?.content ?? '')));
  return mentionsJson ? messages : [...messages, { role: 'system', content: JSON_MODE_NUDGE }];
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
  const j = await postEmbeddings<{ data?: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } }>(target, { input: text });
  // Cost visibility ONLY for the OpenAI-direct branch (target.model is set only there -- see
  // ProviderTarget's own doc comment above). Azure/Foundry spend is a separate, already-credit-
  // funded line this instrumentation is not trying to measure. Never throws (recordOpenAIUsage's
  // own contract); a bug here must never break a real embedding call.
  if (target.model) {
    recordOpenAIUsage({
      model: target.model,
      kind: 'embedding',
      promptTokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0,
      caller: 'gateway-embed',
    });
  }
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
  const j = await postEmbeddings<{
    data?: Array<{ embedding: number[]; index?: number }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  }>(target, {
    input: texts,
  });
  if (target.model) {
    recordOpenAIUsage({
      model: target.model,
      kind: 'embedding',
      promptTokens: j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? 0,
      caller: 'gateway-embed-batch',
    });
  }
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
  opts?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    deployment?: string;
    tier?: 'standard' | 'high' | 'router';
    cacheKey?: string;
    /**
     * PASSTHROUGH for the gpt-5.6 family's reasoning_effort parameter (verified live 2026-09-03:
     * none/low/medium/high/xhigh/max, HTTP 200 on every value; 0 reasoning tokens observed on a
     * simple classification at 'low' or the provider's own unset default). An EXPLICIT value here
     * always wins and is emitted verbatim, on any tier. When UNSET, tier:'router' on a resolved
     * gpt-5.6-family model additionally gets an environment-configured default -- see
     * OPENAI_ROUTER_REASONING_EFFORT in config/env.ts, and this function's own reasoning_effort
     * resolution below -- standard/high tiers are NEVER defaulted this way, even when they too
     * resolve to a gpt-5.6-family model (sol, tier:'high', is one): whether and how to tune
     * reasoning effort for those paths stays a separate, deliberate adoption decision, not a side
     * effect of router's own default existing.
     */
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /**
     * OpenAI-direct service_tier passthrough (live-verified 2026-09-03: 'flex' is accepted on the
     * gpt-5.6 family and bills at 50% of the model's list price -- see telemetry/openai-cost.ts's
     * estimateOpenAICostUsd -- in exchange for a best-effort, no-completion-time-SLA queue, which is
     * why tools/llm/azure.ts only requests it for latencyClass:'background' calls). 'flex' is the
     * only value that changes the request body; 'default' (or omitting this opt entirely) sends
     * nothing, which is already the provider's own default behavior. NEVER sent to Azure OpenAI --
     * see this opt's use below, gated on `target.model` (non-null only on the OpenAI-direct branch,
     * per ProviderTarget's own doc comment above).
     */
    serviceTier?: 'flex' | 'default';
    /**
     * OPTIONAL routing-hint passthrough for OpenAI's own prompt-caching mechanism -- distinct from
     * the Azure-side cache-affinity `promptCacheKey()`/`body.user` already below (same name,
     * different destination and different provider's caching mechanism; see that function's own
     * doc comment). A STABLE value shared by calls of the same shape increases the odds OpenAI
     * routes them to the same warm cache node. Additive and safe across BOTH providers -- like
     * `body.user` below, an unrecognised field is ignored rather than rejected, so this is never
     * provider-gated the way serviceTier above is.
     */
    promptCacheKey?: string;
  },
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
    // See ensureJsonModeMessages(): json_object mode needs the word "json" somewhere in the prompt.
    messages: ensureJsonModeMessages(messages, opts?.jsonMode),
    max_completion_tokens: opts?.maxTokens ?? 1024,
  };
  // temperature: passed through verbatim when a caller sets it, EXCEPT for models that reject any
  // non-default value (see rejectsTemperature() above -- the gpt-5.6 family, live-verified), where
  // it is omitted so the call succeeds instead of 400ing.
  if (typeof opts?.temperature === 'number' && !rejectsTemperature(target.resolvedLabel)) body.temperature = opts.temperature;
  if (opts?.jsonMode) body.response_format = { type: 'json_object' };
  // reasoning_effort: an EXPLICIT caller value always wins (see the reasoningEffort opt's own doc
  // comment above). Failing that, tier:'router' on a resolved gpt-5.6-family model gets the
  // environment-configured default -- OPENAI_ROUTER_REASONING_EFFORT (config/env.ts), a validated
  // enum defaulting to 'low'; the literal value 'off' disables this default outright, leaving
  // reasoning_effort unset exactly as it was before this default existed. standard/high tiers are
  // NEVER defaulted this way, even though high (sol) also resolves to a gpt-5.6-family model.
  let reasoningEffort = opts?.reasoningEffort;
  if (!reasoningEffort && opts?.tier === 'router' && isGpt56Family(target.resolvedLabel)) {
    const routerDefault = loadEnv().OPENAI_ROUTER_REASONING_EFFORT;
    if (routerDefault !== 'off') reasoningEffort = routerDefault;
  }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  // prompt_cache_key: see the promptCacheKey opt's own doc comment above. Unconditional across
  // providers -- same "additive and safe, ignored where unsupported" treatment as `user` below.
  if (opts?.promptCacheKey) body.prompt_cache_key = opts.promptCacheKey;
  // service_tier: OpenAI-direct ONLY -- see the serviceTier opt's own doc comment above for why
  // this one IS provider-gated (unlike prompt_cache_key/`user`). `target.model` is non-null only on
  // the OpenAI-direct branch of chatTarget() (see ProviderTarget's own doc comment), the same
  // discriminator this function already uses below to gate recordOpenAIUsage.
  if (opts?.serviceTier === 'flex' && target.model) body.service_tier = 'flex';
  // Cache-affinity routing for Azure OpenAI automatic prompt caching (see promptCacheKey). Additive
  // and safe: `user` is ignored where unsupported (incl. by OpenAI-direct) and never changes the
  // completion.
  body.user = opts?.cacheKey || promptCacheKey(target.resolvedLabel, messages);
  const j = await postToTarget<{
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    model?: string;
    service_tier?: string;
  }>(target, body);
  const resolvedModel = j.model || target.resolvedLabel;
  // service_tier for cost + telemetry: prefer what the API actually ECHOED BACK (the ground truth
  // of which tier served the request), falling back to what was REQUESTED only when the response
  // does not echo a service_tier at all (defensive -- every response observed during 2026-09-03
  // verification did echo one, but a future response omitting the field must never silently
  // under-report a flex-priced call at full price). Either signal being 'flex' prices/tags as flex.
  const responseServiceTier = typeof j.service_tier === 'string' ? j.service_tier : undefined;
  // The ECHO WINS OUTRIGHT whenever the response carries one; the requested value is used ONLY when
  // the response omits the field entirely. An earlier form of this line OR-ed the two ("either
  // signal being flex counts as flex"), which is wrong in the one direction that matters for money:
  // if flex is REQUESTED but OpenAI serves the call at 'default' (flex is a best-effort queue, and
  // the response is what states which tier actually billed), the OR would still apply the 50%
  // FLEX_SERVICE_TIER_DISCOUNT and under-report real spend, with no signal that it had. Preferring
  // the echo makes an under-report impossible; the requested-value fallback only ever fires when
  // there is no echo to contradict it.
  const resolvedServiceTier = responseServiceTier ?? opts?.serviceTier;
  // Cost visibility ONLY for the OpenAI-direct branch (target.model is set only there -- see
  // ProviderTarget's own doc comment above). Recorded here (inside the shared chat() function)
  // rather than at its one current caller (tools/llm/azure.ts) so any FUTURE caller of chat() gets
  // fleet cost visibility for free too, mirroring how embed()/embedBatch() above are instrumented.
  if (target.model) {
    recordOpenAIUsage({
      model: resolvedModel,
      kind: 'chat',
      promptTokens: j.usage?.prompt_tokens ?? 0,
      completionTokens: j.usage?.completion_tokens ?? 0,
      cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      caller: 'gateway-chat',
      serviceTier: resolvedServiceTier,
    });
  }
  // The API echoes which underlying model actually answered (the Azure Model Router in particular
  // picks one per request); surface that, falling back to the resolved deployment/model label.
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage, model: resolvedModel };
}
