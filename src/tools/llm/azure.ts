/**
 * llm_azure — the FLEET COST PROTOCOL escape hatch. Routes COMMODITY + mid-tier LLM work
 * (summarize, classify, extract, synthesize, complete) onto a credit-funded/lower-cost provider
 * (Azure Foundry by default, or OpenAI-direct when LLM_PROVIDER=openai), instead of burning
 * metered Claude tokens. Available to every agent on every platform via one gateway call.
 *
 * QUALITY TIERS (Matt directive 2026-06-26: gpt-4.1-mini is bad — never default to it):
 *   tier 'standard' (default) -> the well-rounded deployment (FOUNDRY_CHAT_DEPLOYMENT / OPENAI_CHAT_MODEL)
 *   tier 'high'               -> the strongest deployed model (FOUNDRY_HIGH_DEPLOYMENT / OPENAI_HIGH_MODEL)
 * Reserve Claude (this agent) for the hardest reasoning; use this for everything commodity.
 *
 * Env: LLM_PROVIDER (foundry default | openai) selects the backend; see src/azure/foundry.ts's
 * chatTarget() for the full var list per provider and the tier -> model mapping.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { chat, chatConfigured, type ChatMessage } from '../../azure/foundry.js';
import { loadEnv } from '../../config/env.js';
import { captureGatewayEvent, summarizeUsage, overSoftBudget, buildLatencyFields, type LatencyClass } from '../../telemetry/gateway-ops.js';
import { emitLlmMetrics } from '../../telemetry/datadog-metrics.js';
import { checkLlmCache, writeLlmCache, scopeFor } from './semantic-cache.js';
import { checkFaqDeflect, seedFaqStore, faqDeflectOn } from './faq-deflect.js';

const TASK_PROMPTS: Record<string, string> = {
  summarize: 'You are a precise summarizer. Produce a faithful, well-structured summary of the user content. Preserve key facts, numbers, names, and decisions. No preamble.',
  classify: 'You are a classifier. Assign the single best label from the provided set. Reply with only the label; when JSON output is requested, reply with exactly {"label": "<label>"}.',
  extract: 'You are a structured-data extractor. Extract the requested fields from the user content accurately. Reply with JSON only.',
  synthesize: 'You synthesize multiple sources into one coherent, accurate answer grounded strictly in the provided content. Preserve specifics; no outside facts; no preamble.',
  complete: 'You are a capable, concise assistant for routine text work.',
};

/**
 * OPENAI_FLEX_BACKGROUND kill-switch (config/env.ts has the full contract) -- read FRESH from
 * process.env on every check, the same convention this directory's other mode flags use
 * (semantic-cache.ts cacheMode()/similarityThreshold(), faq-deflect.ts faqDeflectOn()), so it stays
 * flippable per-call/per-test without needing loadEnv()'s per-process cache to be re-warmed.
 * Defaults to flex APPLIED (true); the literal string '0' disables it. Exported for direct testing.
 */
export function flexBackgroundEnabled(): boolean {
  return (process.env.OPENAI_FLEX_BACKGROUND || '').trim() !== '0';
}

/**
 * PURE: the BACKGROUND-ONLY chat() opts additions for one llm_azure call. Exported so the wiring
 * is directly unit-testable without standing up the full registered tool.
 *
 * A fire-and-forget/best-effort latencyClass:'background' call can trade OpenAI's completion-time
 * SLA for a 50% service_tier:'flex' discount (config/env.ts's OPENAI_FLEX_BACKGROUND has the full
 * contract), which hot/normal calls never should -- a user-blocking call needs the SLA, not the
 * discount. promptCacheKey is derived from the SAME partition key the semantic cache uses
 * (scopeFor: task+tier+caller lane) rather than the raw input content, so repeated calls of the
 * same SHAPE (a recurring classify/summarize job with a stable system prompt, different payloads
 * each run) share a cache-routing prefix. promptCacheKey is unconditional on latencyClass being
 * 'background' (a pure routing hint, safe regardless of the flex kill-switch); serviceTier is
 * additionally gated on flexBackgroundEnabled() so the switch can disable ONLY the discount+SLA
 * trade-off without touching cache routing. Any non-'background' latencyClass returns {} (no
 * change to today's request body).
 */
export function backgroundChatOpts(
  latencyClass: LatencyClass,
  callerAgent: string,
  task: string,
  tier: string,
): { serviceTier?: 'flex'; promptCacheKey?: string } {
  if (latencyClass !== 'background') return {};
  const opts: { serviceTier?: 'flex'; promptCacheKey?: string } = {
    promptCacheKey: scopeFor(callerAgent, task, tier),
  };
  // NEVER request flex on the ROUTER tier. Live-proven on gateway rev 41 (2026-09-03): with flex
  // applied, tier:'router' + latencyClass:'background' timed out inside the gateway's own request
  // budget on 2 of 2 probes, while tier:'standard' + background (flex applied, no reasoning_effort
  // default) and tier:'router' + normal (reasoning_effort default, no flex) both returned in under
  // a second. The router tier is the one tier that also carries an automatic reasoning_effort
  // default (see azure/foundry.ts chat()), and reasoning work on a best-effort queue with no
  // completion-time SLA is what pushes it past the budget. Excluding just this one tier keeps the
  // 50% discount on every other background call, which a blanket OPENAI_FLEX_BACKGROUND=0 would
  // throw away. Router is also the tier that least needs it: it exists to pick the
  // cheapest-sufficient model, so its per-call cost is already the smallest of the three.
  if (tier !== 'router' && flexBackgroundEnabled()) opts.serviceTier = 'flex';
  return opts;
}

export function registerLlmAzure(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'llm_azure',
      category: 'read',
      annotations: {
        title: 'Credit-funded Azure LLM (gpt-4.1, tiered)',
        description:
          'Run summarize / classify / extract / synthesize / complete on credit-funded Azure OpenAI (Foundry) instead of metered Claude tokens (FLEET COST PROTOCOL). Default tier "standard" = gpt-4.1 (good quality); tier "high" = the strongest deployed model for hard reasoning / quality-critical synthesis. Do NOT use for the very hardest reasoning — keep that on Claude. Read/compute; mutates nothing.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        task: z.enum(['summarize', 'classify', 'extract', 'synthesize', 'complete']).describe('The task type.'),
        input: z.string().min(1).describe('The content to operate on.'),
        tier: z.enum(['standard', 'high', 'router']).optional().describe('standard=gpt-5.1 (default), high=gpt-5.4 (quality-critical), router=Azure Model Router auto-picks the cheapest-sufficient model.'),
        instructions: z.string().optional().describe('Optional extra guidance (fields to extract, summary length, focus).'),
        labels: z.array(z.string()).optional().describe('For task=classify: the candidate labels.'),
        jsonMode: z.boolean().optional().describe('Force strict JSON output (recommended for extract/classify pipelines).'),
        maxTokens: z.number().int().min(16).max(8192).optional().describe('Max output tokens (default 1500).'),
        latencyClass: z
          .enum(['hot', 'normal', 'background'])
          .optional()
          .describe(
            'Telemetry tag for p95-by-class dashboards: "hot" for a user-blocking interactive call, "background" for a fire-and-forget/best-effort call, "normal" (default) otherwise. Does not change execution, only how the call is bucketed.',
          ),
      },
      outputShape: {
        task: z.string(),
        tier: z.string(),
        output: z.string(),
        model: z.string(),
        usage: z.unknown().optional(),
        error: z.string().optional(),
        cache_hit: z.boolean().optional(),
        deflected: z.boolean().optional(),
      },
      handler: async (input, ctx) => {
        const tier = input.tier ?? 'standard';
        // W1-6 SPEED INSTRUMENTATION: caller-passed telemetry bucket (see buildLatencyFields in
        // telemetry/gateway-ops.ts). Purely a dashboard tag -- never changes execution.
        const latencyClass: LatencyClass = input.latencyClass ?? 'normal';
        if (!chatConfigured()) {
          const provider = loadEnv().LLM_PROVIDER;
          return {
            data: {
              task: input.task,
              tier,
              output: '',
              model: '',
              // Kept as 'foundry_unconfigured' on the default provider for byte-identical
              // backward-compat with anything keyed on this exact string; the openai case gets its
              // own accurate code rather than a misleading Foundry-flavoured one.
              error: provider === 'openai' ? 'openai_unconfigured' : 'foundry_unconfigured',
            },
            summary:
              provider === 'openai'
                ? 'llm_azure unavailable: LLM_PROVIDER=openai but OPENAI_API_KEY not configured on the gateway.'
                : 'llm_azure unavailable: Foundry endpoint/key not configured on the gateway.',
          };
        }

        // DETERMINISTIC FAQ/INTENT DEFLECTION (FAQ_DEFLECT_MODE=on): for task='complete' inbound
        // questions, check the curated FAQ store BEFORE touching the model at all. Mode-gated +
        // fail-open, mirrors LLM_CACHE_MODE/SHIELD_MODE/GROUNDEDNESS_MODE: any failure (Cosmos
        // down, embed() throws) silently falls through to the normal chat() call below. See
        // faq-deflect.ts for the store choice + why this over Azure AI Language CLU/CQA.
        const faqHit = await checkFaqDeflect(input.input, input.task);
        if (faqHit.hit && faqHit.answer) {
          captureGatewayEvent('gateway_faq_deflect_hit', {
            task: input.task,
            tier,
            faq_id: faqHit.faqId,
            similarity: faqHit.similarity,
          });
          return {
            data: { task: input.task, tier, output: faqHit.answer, model: 'faq-deflect', deflected: true },
            summary:
              `llm_azure ${input.task} answered by the FAQ deflection layer ` +
              `(faq_id ${faqHit.faqId}, similarity ${faqHit.similarity?.toFixed(4)}). ` +
              `No model call made — Claude AND Azure tokens saved.`,
          };
        }
        // Best-effort self-heal of the curated store; cheap no-op once entries already exist with
        // a live vector. Fire-and-forget so a seed failure never delays or affects this call.
        if (input.task === 'complete' && faqDeflectOn()) void seedFaqStore().catch(() => undefined);

        const sys = TASK_PROMPTS[input.task] ?? TASK_PROMPTS.complete;
        const parts: string[] = [];
        if (input.instructions) parts.push(`Instructions: ${input.instructions}`);
        if (input.task === 'classify' && input.labels?.length) parts.push(`Allowed labels: ${input.labels.join(', ')}`);
        parts.push(`Content:\n${input.input}`);
        const messages: ChatMessage[] = [
          { role: 'system', content: sys! },
          { role: 'user', content: parts.join('\n\n') },
        ];

        // Cache key text: everything that shapes the answer besides task/tier/lane (which are
        // baked into the cache partition, see semantic-cache.ts scopeFor) — instructions, labels,
        // jsonMode, and the input content itself. Two calls that differ only in whitespace/wording
        // but mean the same thing can still land within the similarity threshold.
        const cachePrompt = [
          input.instructions ?? '',
          input.task === 'classify' ? (input.labels ?? []).join(',') : '',
          input.jsonMode ? 'json' : '',
          input.input,
        ].join('\n---\n');

        // SEMANTIC RESPONSE CACHE (LLM_CACHE_MODE=on): cache-check BEFORE the model call.
        // Mode-gated + fail-open, mirroring COMPLIANCE_MODE/SHIELD_MODE/GROUNDEDNESS_MODE: any
        // cache failure (Cosmos down, embed() throws) silently falls through to a normal chat()
        // call below. See semantic-cache.ts for the store choice + why.
        const cacheCheckStarted = Date.now();
        const cacheLookup = await checkLlmCache(cachePrompt, ctx.callerAgent, input.task, tier);
        if (cacheLookup.hit && cacheLookup.entry) {
          // W1-6: same latency+cache shape as the real-call path below (buildLatencyFields), tagged
          // cache_hit:true, so p95 latency is directly comparable across cache_hit in PostHog --
          // this is the measurement that PROVES the semantic cache's hot path is faster, rather than
          // just asserting it.
          captureGatewayEvent('gateway_llm_cache_hit', {
            task: input.task,
            tier,
            similarity: cacheLookup.similarity,
            // buildLatencyFields below already supplies `model` (identical value); listed once to
            // satisfy TS2783 (duplicate object key), not a behavior change.
            ...buildLatencyFields({
              startedAt: cacheCheckStarted,
              endedAt: Date.now(),
              model: cacheLookup.entry.model,
              cacheHit: true,
              cachedPct: 100,
              latencyClass,
            }),
          });
          return {
            data: {
              task: input.task,
              tier,
              output: cacheLookup.entry.output,
              model: cacheLookup.entry.model,
              usage: cacheLookup.entry.usage,
              cache_hit: true,
            },
            summary:
              `llm_azure ${input.task} served from the semantic response cache ` +
              `(similarity ${cacheLookup.similarity?.toFixed(4)}, model ${cacheLookup.entry.model}). ` +
              `No fresh model call made — Claude AND Azure tokens saved.`,
          };
        }

        try {
          // W1-6: bracket ONLY the chat() call itself (not cache lookup / prompt assembly above) so
          // duration_ms is the true per-LLM-call wall-clock latency. Foundry's chat() has no
          // streaming mode today, so ttft_ms can never be genuinely measured here -- buildLatencyFields
          // omits it rather than faking a value (see gateway-ops.ts).
          const modelStarted = Date.now();
          const res = await chat(messages, {
            maxTokens: input.maxTokens ?? 1500,
            jsonMode: input.jsonMode ?? input.task === 'extract',
            tier,
            ...backgroundChatOpts(latencyClass, ctx.callerAgent, input.task, tier),
          });
          const modelEnded = Date.now();
          // Observe-only per-call cost/usage event -> Gateway Ops project (fire-and-forget,
          // inert unless POSTHOG_GATEWAYOPS_KEY is set; never affects the response). Enriched with
          // the flattened usage summary (incl. cached_tokens / cached_pct so the automatic-prompt-cache
          // hit rate is visible), a report-mode per-call soft-budget flag for the cost monitors, and
          // the buildLatencyFields shape (duration_ms/cache_hit/model/latency_class, ttft_ms when
          // genuinely available) so p95 latency is visible per class right alongside cost.
          const usageSummary = summarizeUsage(res.usage);
          captureGatewayEvent('gateway_llm_call', {
            task: input.task,
            tier,
            usage: res.usage ?? null,
            ...usageSummary,
            over_soft_budget: overSoftBudget(usageSummary),
            output_chars: res.text.length,
            // buildLatencyFields below already supplies `model` (identical value); listed once to
            // satisfy TS2783 (duplicate object key), not a behavior change.
            ...buildLatencyFields({
              startedAt: modelStarted,
              endedAt: modelEnded,
              model: res.model,
              cacheHit: false,
              cachedPct: usageSummary.cached_pct,
              latencyClass,
            }),
          });
          // Same cost/cache signal to Datadog custom metrics (otc.gateway.llm.*), so the Fleet
          // cost dashboard can chart cache-hit rate alongside the Azure token metrics. Inert unless
          // DD_API_KEY is set; fire-and-forget, never affects the response.
          emitLlmMetrics(res.model, input.task, usageSummary);

          // Best-effort write-back into the semantic cache (fire-and-forget; a write failure must
          // never affect the response, mirrors memory/hot-cache.ts's writeCache pattern).
          void writeLlmCache(cachePrompt, ctx.callerAgent, input.task, tier, {
            output: res.text,
            model: res.model,
            usage: res.usage,
          }).catch(() => undefined);

          return {
            data: { task: input.task, tier, output: res.text, model: res.model, usage: res.usage, cache_hit: false },
            summary: `llm_azure ${input.task} on ${res.model} (tier=${tier}, ${res.text.length} chars). Claude tokens saved.`,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { task: input.task, tier, output: '', model: '', error: msg }, summary: `llm_azure failed: ${msg}` };
        }
      },
    },
    callerHash,
  );
}
