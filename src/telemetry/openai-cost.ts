/**
 * OpenAI cost visibility for the gateway -- the TypeScript counterpart to
 * otchealth-claude-tools/setup/openai-usage.mjs (see that file's own header for the full "why":
 * the fleet's OpenAI credential is a project key, which cannot read OpenAI's own Usage/Admin APIs,
 * so this measures at the SOURCE instead -- every OpenAI response carries a `usage` object, and
 * this turns that into the SAME `otc.fleet.openai.*` Datadog metrics the toolkit emits, tagged
 * `repo:otchealth-mcp-server` so a fleet-wide query can tell the two origins apart without needing
 * two separate dashboards).
 *
 * The two repos cannot share code directly (a Node-ESM toolkit repo and this gateway's own
 * TypeScript build), so the price table below is a DELIBERATE, DOCUMENTED PORT of the toolkit's
 * table, not a shared module -- keep the two in sync when either is refreshed against OpenAI's
 * pricing page. See otchealth-claude-tools/docs/OPENAI-COST-VISIBILITY.md for the full contract
 * (what this can and cannot prove, the unknown_model bucket, how to reconcile).
 *
 * SAFETY CONTRACT (mirrors the toolkit's, and this file's own callers in src/azure/foundry.ts):
 * recordOpenAIUsage() NEVER throws. It is synchronous from the caller's point of view (the actual
 * Datadog POST is fire-and-forget inside emitOpenAIFleetMetrics -- see datadog-metrics.ts), and a
 * bug here must never break the real OpenAI call site it is bolted onto.
 */
import { emitOpenAIFleetMetrics, openAIUsageMetricPoints } from './datadog-metrics.js';

export const PRICE_TABLE_VERSION = '2026-09-02';

interface ChatPriceRule {
  re: RegExp;
  input: number;
  output: number;
  cachedInput: number;
}

interface EmbeddingPriceRule {
  re: RegExp;
  input: number;
}

// USD per 1,000,000 tokens. Mirrors otchealth-claude-tools/setup/openai-usage.mjs's CHAT_PRICES
// exactly (see that file for the full "why these numbers, why this shape" reasoning) -- ordered
// rules, first match wins, anchored (not loose-prefix) so a genuinely different/newer model
// (gpt-4.15, gpt-5.6-luna, ...) falls through to the unknown_model bucket instead of silently
// absorbing a family's pricing it was never confirmed to share.
const CHAT_PRICES: ChatPriceRule[] = [
  { re: /^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/i, input: 0.15, output: 0.6, cachedInput: 0.075 },
  { re: /^gpt-4o(-\d{4}-\d{2}-\d{2})?$/i, input: 2.5, output: 10.0, cachedInput: 1.25 },
  { re: /^gpt-4\.1-nano(-\d{4}-\d{2}-\d{2})?$/i, input: 0.1, output: 0.4, cachedInput: 0.025 },
  { re: /^gpt-4\.1-mini(-\d{4}-\d{2}-\d{2})?$/i, input: 0.4, output: 1.6, cachedInput: 0.1 },
  { re: /^gpt-4\.1(-\d{4}-\d{2}-\d{2})?$/i, input: 2.0, output: 8.0, cachedInput: 0.5 },
  { re: /^gpt-3\.5-turbo(-\d{4})?$/i, input: 0.5, output: 1.5, cachedInput: 0.25 },
];

const EMBEDDING_PRICES: EmbeddingPriceRule[] = [
  { re: /^text-embedding-3-large$/i, input: 0.13 },
  { re: /^text-embedding-3-small$/i, input: 0.02 },
  { re: /^text-embedding-ada-002$/i, input: 0.1 },
];

const MOST_EXPENSIVE_CHAT = CHAT_PRICES.reduce((a, b) => (b.output > a.output ? b : a));
const MOST_EXPENSIVE_EMBEDDING = EMBEDDING_PRICES.reduce((a, b) => (b.input > a.input ? b : a));

function matchChatPrice(model: string): { input: number; output: number; cachedInput: number; unknown: boolean } {
  for (const p of CHAT_PRICES) {
    if (p.re.test(model)) return { input: p.input, output: p.output, cachedInput: p.cachedInput, unknown: false };
  }
  return { input: MOST_EXPENSIVE_CHAT.input, output: MOST_EXPENSIVE_CHAT.output, cachedInput: MOST_EXPENSIVE_CHAT.cachedInput, unknown: true };
}

function matchEmbeddingPrice(model: string): { input: number; unknown: boolean } {
  for (const p of EMBEDDING_PRICES) {
    if (p.re.test(model)) return { input: p.input, unknown: false };
  }
  return { input: MOST_EXPENSIVE_EMBEDDING.input, unknown: true };
}

export type OpenAIUsageKind = 'chat' | 'embedding' | 'other';

/** PURE. Estimate USD cost for one usage event. Exported for direct unit testing. */
export function estimateOpenAICostUsd(input: {
  model: string;
  kind: OpenAIUsageKind;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}): { costUsd: number; unknown: boolean } {
  const model = input.model || 'unknown';
  if (input.kind === 'embedding') {
    const price = matchEmbeddingPrice(model);
    return { costUsd: (Math.max(0, input.promptTokens) / 1e6) * price.input, unknown: price.unknown };
  }
  const price = matchChatPrice(model);
  const pt = Math.max(0, input.promptTokens);
  const cached = Math.max(0, Math.min(input.cachedTokens, pt));
  const fresh = Math.max(0, pt - cached);
  const inputCost = (fresh / 1e6) * price.input + (cached / 1e6) * price.cachedInput;
  const outputCost = (Math.max(0, input.completionTokens) / 1e6) * price.output;
  return { costUsd: inputCost + outputCost, unknown: price.unknown };
}

export interface RecordOpenAIUsageInput {
  model: string;
  kind: OpenAIUsageKind;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  caller: string;
}

/**
 * Record ONE real OpenAI API response from the gateway. Call this once per successful call, from
 * inside the code that already parsed that response's `usage` object -- see src/azure/foundry.ts's
 * chat()/embed()/embedBatch() for the current call sites (the ONLY place in the gateway that talks
 * to api.openai.com directly). NEVER throws.
 */
export function recordOpenAIUsage(input: RecordOpenAIUsageInput): void {
  try {
    const model = (input.model || 'unknown').trim() || 'unknown';
    const kind: OpenAIUsageKind = input.kind === 'embedding' ? 'embedding' : input.kind === 'chat' ? 'chat' : 'other';
    const caller = (input.caller || 'unknown').trim() || 'unknown';
    const promptTokens = Math.max(0, Number(input.promptTokens) || 0);
    const completionTokens = Math.max(0, Number(input.completionTokens) || 0);
    const cachedTokens = Math.max(0, Math.min(Number(input.cachedTokens) || 0, promptTokens));
    const { costUsd, unknown } = estimateOpenAICostUsd({ model, kind, promptTokens, completionTokens, cachedTokens });
    emitOpenAIFleetMetrics(
      openAIUsageMetricPoints({
        model,
        kind,
        caller,
        repo: 'otchealth-mcp-server',
        unknown,
        promptTokens,
        completionTokens,
        costUsd,
      }),
    );
  } catch {
    // Never let a bug in cost-visibility instrumentation break the real OpenAI call site it is
    // bolted onto -- mirrors the toolkit's identical contract.
  }
}
