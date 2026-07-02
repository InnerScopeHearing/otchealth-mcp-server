/**
 * llm_azure — the FLEET COST PROTOCOL escape hatch. Routes COMMODITY + mid-tier LLM work
 * (summarize, classify, extract, synthesize, complete) onto credit-funded Azure OpenAI on
 * Foundry, instead of burning metered Claude tokens. Available to every agent on every
 * platform via one gateway call.
 *
 * QUALITY TIERS (Matt directive 2026-06-26: gpt-4.1-mini is bad — never default to it):
 *   tier 'standard' (default) -> gpt-4.1  (the GOOD model; use for real summarization/synthesis)
 *   tier 'high'               -> the strongest deployed model (FOUNDRY_HIGH_DEPLOYMENT)
 * Reserve Claude (this agent) for the hardest reasoning; use this for everything commodity.
 *
 * Env: FOUNDRY_OPENAI_ENDPOINT + FOUNDRY_KEY (+ FOUNDRY_CHAT_DEPLOYMENT / FOUNDRY_HIGH_DEPLOYMENT).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { chat, foundryConfigured, type ChatMessage } from '../../azure/foundry.js';
import { captureGatewayEvent, summarizeUsage, overSoftBudget } from '../../telemetry/gateway-ops.js';
import { emitLlmMetrics } from '../../telemetry/datadog-metrics.js';
import { checkLlmCache, writeLlmCache } from './semantic-cache.js';
import { checkFaqDeflect, seedFaqStore, faqDeflectOn } from './faq-deflect.js';

const TASK_PROMPTS: Record<string, string> = {
  summarize: 'You are a precise summarizer. Produce a faithful, well-structured summary of the user content. Preserve key facts, numbers, names, and decisions. No preamble.',
  classify: 'You are a classifier. Assign the single best label from the provided set. Reply with only the label.',
  extract: 'You are a structured-data extractor. Extract the requested fields from the user content accurately. Reply with JSON only.',
  synthesize: 'You synthesize multiple sources into one coherent, accurate answer grounded strictly in the provided content. Preserve specifics; no outside facts; no preamble.',
  complete: 'You are a capable, concise assistant for routine text work.',
};

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
        if (!foundryConfigured()) {
          return {
            data: { task: input.task, tier, output: '', model: '', error: 'foundry_unconfigured' },
            summary: 'llm_azure unavailable: Foundry endpoint/key not configured on the gateway.',
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
        const cacheLookup = await checkLlmCache(cachePrompt, ctx.callerAgent, input.task, tier);
        if (cacheLookup.hit && cacheLookup.entry) {
          captureGatewayEvent('gateway_llm_cache_hit', {
            task: input.task,
            tier,
            model: cacheLookup.entry.model,
            similarity: cacheLookup.similarity,
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
          const res = await chat(messages, {
            maxTokens: input.maxTokens ?? 1500,
            jsonMode: input.jsonMode ?? input.task === 'extract',
            tier,
          });
          // Observe-only per-call cost/usage event -> Gateway Ops project (fire-and-forget,
          // inert unless POSTHOG_GATEWAYOPS_KEY is set; never affects the response). Enriched with
          // the flattened usage summary (incl. cached_tokens / cached_pct so the automatic-prompt-cache
          // hit rate is visible) and a report-mode per-call soft-budget flag for the cost monitors.
          const usageSummary = summarizeUsage(res.usage);
          captureGatewayEvent('gateway_llm_call', {
            task: input.task,
            tier,
            model: res.model,
            usage: res.usage ?? null,
            ...usageSummary,
            over_soft_budget: overSoftBudget(usageSummary),
            output_chars: res.text.length,
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
