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
// fetchWithBudget; post() below still sees exactly one final Response and preserves its existing
// error shape (FoundryError with the LAST observed status) whether or not a retry happened.
async function post<T>(url: string, key: string, body: unknown): Promise<T> {
  const res = await fetchWithBudget(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (res.status >= 400) {
    const msg = (data as any)?.error?.message ?? `HTTP ${res.status}`;
    throw new FoundryError(res.status, msg);
  }
  return data as T;
}

/** Embed a single string with text-embedding-3-large. Returns the vector, or null when unconfigured. */
export async function embed(text: string): Promise<number[] | null> {
  const c = cfg();
  if (!c) return null;
  const url = `${c.ep}/openai/deployments/${c.embed}/embeddings?api-version=${API_VERSION}`;
  const j = await post<{ data?: Array<{ embedding: number[] }> }>(url, c.key, { input: text });
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
  const c = cfg();
  if (!c) return null;
  if (texts.length === 0) return [];
  const url = `${c.ep}/openai/deployments/${c.embed}/embeddings?api-version=${API_VERSION}`;
  const j = await post<{ data?: Array<{ embedding: number[]; index?: number }> }>(url, c.key, {
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

/** Chat completion on a credit-funded Foundry deployment (default gpt-5.1), or the Model Router. */
export async function chat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean; deployment?: string; tier?: 'standard' | 'high' | 'router'; cacheKey?: string },
): Promise<{ text: string; usage?: unknown; model: string }> {
  const c = cfg();
  if (!c) throw new FoundryError(0, 'Foundry not configured (FOUNDRY_OPENAI_ENDPOINT/FOUNDRY_KEY unset)');
  // Resolve endpoint/key/deployment by tier. 'router' uses the Azure Model Router (auto-picks the
  // cheapest-sufficient model); falls back to Foundry standard if the router isn't configured.
  let ep = c.ep, key = c.key, deployment = opts?.deployment || (opts?.tier === 'high' ? c.high : c.chat);
  if (opts?.tier === 'router') {
    const e = loadEnv();
    if (e.FOUNDRY_ROUTER_ENDPOINT && e.FOUNDRY_ROUTER_KEY) {
      ep = e.FOUNDRY_ROUTER_ENDPOINT.replace(/\/+$/, '');
      key = e.FOUNDRY_ROUTER_KEY;
      deployment = e.FOUNDRY_ROUTER_DEPLOYMENT || 'model-router';
    }
  }
  const url = `${ep}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`;
  // gpt-5 / o-series reasoning models require max_completion_tokens (not max_tokens) and reject a
  // custom temperature (only the default is allowed). Use the new param and only pass temperature
  // when a caller explicitly sets it (kept for older gpt-4.x deployments).
  const body: Record<string, unknown> = {
    messages,
    max_completion_tokens: opts?.maxTokens ?? 1024,
  };
  if (typeof opts?.temperature === 'number') body.temperature = opts.temperature;
  if (opts?.jsonMode) body.response_format = { type: 'json_object' };
  // Cache-affinity routing for Azure OpenAI automatic prompt caching (see promptCacheKey). Additive
  // and safe: `user` is ignored where unsupported and never changes the completion.
  body.user = opts?.cacheKey || promptCacheKey(deployment, messages);
  const j = await post<{ choices?: Array<{ message?: { content?: string } }>; usage?: unknown; model?: string }>(url, key, body);
  // The router echoes which underlying model it picked in `model`; surface that.
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage, model: j.model || deployment };
}
