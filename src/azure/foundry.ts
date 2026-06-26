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
import { request } from 'undici';
import { loadEnv } from '../config/env.js';

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

async function post<T>(url: string, key: string, body: unknown): Promise<T> {
  const { statusCode, body: rb } = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify(body),
  });
  const text = await rb.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (statusCode >= 400) {
    const msg = (data as any)?.error?.message ?? `HTTP ${statusCode}`;
    throw new FoundryError(statusCode, msg);
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Chat completion on a credit-funded Foundry deployment (default gpt-4.1). Throws when unconfigured. */
export async function chat(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; jsonMode?: boolean; deployment?: string },
): Promise<{ text: string; usage?: unknown; model: string }> {
  const c = cfg();
  if (!c) throw new FoundryError(0, 'Foundry not configured (FOUNDRY_OPENAI_ENDPOINT/FOUNDRY_KEY unset)');
  const deployment = opts?.deployment || c.chat;
  const url = `${c.ep}/openai/deployments/${deployment}/chat/completions?api-version=${API_VERSION}`;
  const body: Record<string, unknown> = {
    messages,
    temperature: opts?.temperature ?? 0.2,
    max_tokens: opts?.maxTokens ?? 1024,
  };
  if (opts?.jsonMode) body.response_format = { type: 'json_object' };
  const j = await post<{ choices?: Array<{ message?: { content?: string } }>; usage?: unknown }>(url, c.key, body);
  return { text: j.choices?.[0]?.message?.content ?? '', usage: j.usage, model: deployment };
}
