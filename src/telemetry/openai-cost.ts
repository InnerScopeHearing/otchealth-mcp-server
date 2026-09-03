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

export const PRICE_TABLE_VERSION = '2026-09-03';

interface ChatPriceTier {
  input: number;
  output: number;
  cachedInput: number;
}

interface ChatPriceRule {
  re: RegExp;
  /** The default (short-context) price tier -- used whenever a rule has no `long` tier, or the
   *  request's prompt-token count does not exceed `longContextThresholdTokens`. */
  short: ChatPriceTier;
  /** Optional long-context price tier. Only the GPT-5.6 family currently publishes a documented
   *  long-context price break (confirmed live 2026-09-03: threshold is PROMPT tokens above
   *  272,000). Every other family in this table has one flat rate regardless of context length, so
   *  `long`/`longContextThresholdTokens` stay unset for them and matchChatPrice() always resolves
   *  to `short`. */
  long?: ChatPriceTier;
  longContextThresholdTokens?: number;
}

interface EmbeddingPriceRule {
  re: RegExp;
  input: number;
}

// USD per 1,000,000 tokens. Mirrors otchealth-claude-tools/setup/openai-usage.mjs's CHAT_PRICES
// exactly (see that file for the full "why these numbers, why this shape" reasoning) -- ordered
// rules, first match wins, anchored (not loose-prefix) so a genuinely different/newer model
// (gpt-4.15, gpt-5.7, ...) falls through to the unknown_model bucket instead of silently absorbing
// a family's pricing it was never confirmed to share. (gpt-5.6 itself -- sol/terra/luna -- moved
// from "genuinely unknown" to explicitly priced below on 2026-09-03; do not reuse those three names
// as "still unknown" examples anywhere, including in tests.)
const CHAT_PRICES: ChatPriceRule[] = [
  { re: /^gpt-4o-mini(-\d{4}-\d{2}-\d{2})?$/i, short: { input: 0.15, output: 0.6, cachedInput: 0.075 } },
  { re: /^gpt-4o(-\d{4}-\d{2}-\d{2})?$/i, short: { input: 2.5, output: 10.0, cachedInput: 1.25 } },
  { re: /^gpt-4\.1-nano(-\d{4}-\d{2}-\d{2})?$/i, short: { input: 0.1, output: 0.4, cachedInput: 0.025 } },
  { re: /^gpt-4\.1-mini(-\d{4}-\d{2}-\d{2})?$/i, short: { input: 0.4, output: 1.6, cachedInput: 0.1 } },
  { re: /^gpt-4\.1(-\d{4}-\d{2}-\d{2})?$/i, short: { input: 2.0, output: 8.0, cachedInput: 0.5 } },
  { re: /^gpt-3\.5-turbo(-\d{4})?$/i, short: { input: 0.5, output: 1.5, cachedInput: 0.25 } },
  // GPT-5.6 family (verified live 2026-09-03, OpenAI list prices per 1M tokens). Long-context
  // pricing applies once the PROMPT (input) token count exceeds 272,000, matching the published
  // short/long split for all three models.
  //   luna  -- the CHEAP tier (src/azure/foundry.ts openaiModelForTier() tier:'router' default).
  {
    re: /^gpt-5\.6-luna(-\d{4}-\d{2}-\d{2})?$/i,
    short: { input: 0.2, output: 1.2, cachedInput: 0.02 },
    long: { input: 0.4, output: 1.8, cachedInput: 0.04 },
    longContextThresholdTokens: 272_000,
  },
  //   terra -- the STANDARD tier default (tier:'standard').
  {
    re: /^gpt-5\.6-terra(-\d{4}-\d{2}-\d{2})?$/i,
    short: { input: 2.0, output: 12.0, cachedInput: 0.2 },
    long: { input: 4.0, output: 18.0, cachedInput: 0.4 },
    longContextThresholdTokens: 272_000,
  },
  //   sol   -- the QUALITY tier default (tier:'high'). PROMO pricing through 2026-11-21 per
  //   OpenAI's own list-price page as of 2026-09-03; this table has no auto-expiry for a promo, so
  //   re-verify sol's rate after that date.
  {
    re: /^gpt-5\.6-sol(-\d{4}-\d{2}-\d{2})?$/i,
    short: { input: 4.0, output: 20.0, cachedInput: 0.4 },
    long: { input: 8.0, output: 30.0, cachedInput: 0.8 },
    longContextThresholdTokens: 272_000,
  },
];

const EMBEDDING_PRICES: EmbeddingPriceRule[] = [
  { re: /^text-embedding-3-large$/i, input: 0.13 },
  { re: /^text-embedding-3-small$/i, input: 0.02 },
  { re: /^text-embedding-ada-002$/i, input: 0.1 },
];

// The fallback for an UNKNOWN chat model must never under-price relative to any known price point
// -- short OR long-context -- of any known family, so this maximizes over every tier this table
// defines (today: gpt-5.6-sol's long-context tier, output $30/1M), not just each rule's own short
// tier. Ranked by `.output` alone, matching this table's pre-existing (pre-2026-09-03) heuristic.
const ALL_CHAT_TIERS: ChatPriceTier[] = CHAT_PRICES.flatMap((p) => (p.long ? [p.short, p.long] : [p.short]));
const MOST_EXPENSIVE_CHAT = ALL_CHAT_TIERS.reduce((a, b) => (b.output > a.output ? b : a));
const MOST_EXPENSIVE_EMBEDDING = EMBEDDING_PRICES.reduce((a, b) => (b.input > a.input ? b : a));

function matchChatPrice(model: string, promptTokens: number): { input: number; output: number; cachedInput: number; unknown: boolean } {
  for (const p of CHAT_PRICES) {
    if (p.re.test(model)) {
      const useLong = p.long !== undefined && p.longContextThresholdTokens !== undefined && promptTokens > p.longContextThresholdTokens;
      const tier = useLong ? p.long! : p.short;
      return { input: tier.input, output: tier.output, cachedInput: tier.cachedInput, unknown: false };
    }
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

/**
 * OpenAI's 'flex' service tier bills at exactly 50% of the model's normal (short/long-context)
 * list price, in exchange for a best-effort queue with no completion-time SLA (live-verified
 * 2026-09-03 on the gpt-5.6 family). This is a POST-hoc discount on top of whatever
 * matchChatPrice()/matchEmbeddingPrice() resolved -- not a separate price table -- because flex is
 * a billing MODE, not a different model: the per-token rates it discounts are the same numbers
 * CHAT_PRICES/EMBEDDING_PRICES already publish for that model at 'default'.
 */
const FLEX_SERVICE_TIER_DISCOUNT = 0.5;

/** PURE. Estimate USD cost for one usage event. Exported for direct unit testing. */
export function estimateOpenAICostUsd(input: {
  model: string;
  kind: OpenAIUsageKind;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 'flex' halves the estimate via FLEX_SERVICE_TIER_DISCOUNT above; any other value (or unset)
   *  is full price. Pass the caller's OWN resolved value here (see src/azure/foundry.ts chat()'s
   *  resolvedServiceTier -- prefers what the API echoed back, falls back to what was requested). */
  serviceTier?: string;
}): { costUsd: number; unknown: boolean } {
  const model = input.model || 'unknown';
  const pt = Math.max(0, input.promptTokens);
  const discount = input.serviceTier === 'flex' ? FLEX_SERVICE_TIER_DISCOUNT : 1;
  if (input.kind === 'embedding') {
    const price = matchEmbeddingPrice(model);
    return { costUsd: (pt / 1e6) * price.input * discount, unknown: price.unknown };
  }
  // promptTokens decides short vs. long-context pricing for families that publish a break (see
  // ChatPriceRule.longContextThresholdTokens) -- so it must be resolved BEFORE matching the price.
  const price = matchChatPrice(model, pt);
  const cached = Math.max(0, Math.min(input.cachedTokens, pt));
  const fresh = Math.max(0, pt - cached);
  const inputCost = (fresh / 1e6) * price.input + (cached / 1e6) * price.cachedInput;
  const outputCost = (Math.max(0, input.completionTokens) / 1e6) * price.output;
  return { costUsd: (inputCost + outputCost) * discount, unknown: price.unknown };
}

export interface RecordOpenAIUsageInput {
  model: string;
  kind: OpenAIUsageKind;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  caller: string;
  /** See estimateOpenAICostUsd's own doc comment -- 'flex' halves the recorded cost estimate and
   *  is also passed through to the Datadog tag (openAIUsageMetricPoints), so cost dashboards can
   *  break down spend by service tier. Optional; omitted/non-'flex' means full price, tagged
   *  'default'. */
  serviceTier?: string;
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
    const serviceTier = input.serviceTier;
    const { costUsd, unknown } = estimateOpenAICostUsd({ model, kind, promptTokens, completionTokens, cachedTokens, serviceTier });
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
        serviceTier,
      }),
    );
  } catch {
    // Never let a bug in cost-visibility instrumentation break the real OpenAI call site it is
    // bolted onto -- mirrors the toolkit's identical contract.
  }
}
