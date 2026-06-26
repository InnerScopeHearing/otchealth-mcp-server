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
import { chat, foundryConfigured, deploymentForTier, type ChatMessage } from '../../azure/foundry.js';

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
        tier: z.enum(['standard', 'high']).optional().describe('standard=gpt-4.1 (default), high=strongest deployed model for quality-critical work.'),
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
      },
      handler: async (input) => {
        const tier = input.tier ?? 'standard';
        if (!foundryConfigured()) {
          return {
            data: { task: input.task, tier, output: '', model: '', error: 'foundry_unconfigured' },
            summary: 'llm_azure unavailable: Foundry endpoint/key not configured on the gateway.',
          };
        }
        const deployment = deploymentForTier(tier) ?? undefined;
        const sys = TASK_PROMPTS[input.task] ?? TASK_PROMPTS.complete;
        const parts: string[] = [];
        if (input.instructions) parts.push(`Instructions: ${input.instructions}`);
        if (input.task === 'classify' && input.labels?.length) parts.push(`Allowed labels: ${input.labels.join(', ')}`);
        parts.push(`Content:\n${input.input}`);
        const messages: ChatMessage[] = [
          { role: 'system', content: sys! },
          { role: 'user', content: parts.join('\n\n') },
        ];
        try {
          const res = await chat(messages, {
            maxTokens: input.maxTokens ?? 1500,
            jsonMode: input.jsonMode ?? input.task === 'extract',
            deployment,
          });
          return {
            data: { task: input.task, tier, output: res.text, model: res.model, usage: res.usage },
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
