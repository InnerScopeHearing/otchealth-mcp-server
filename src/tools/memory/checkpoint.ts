/**
 * checkpoint — platform-agnostic session-end capture, so ANY engine (Claude Code, ChatGPT,
 * Copilot, Hyperagent) can persist durable memory at session end, not just the Claude Code Stop
 * hook (which only exists on one platform). Part of the Phase 2 capture plane alongside the
 * auto-journal (safety/journal.ts, wired into every mutating tool call) and the capture-pressure
 * nudge (safety/capture-pressure.ts, which THIS tool resets).
 *
 * Three things happen, in order, each independently fail-open:
 *  (a) any EXPLICIT `memories` the caller supplies are written VERBATIM (no LLM in the loop) via
 *      the same writeMemory + indexMemoryNow path every other durable memory uses.
 *  (b) if a `summary` is given and the shared Azure LLM (azure/foundry.ts chat()) is configured,
 *      it is distilled server-side into 0-3 atomic durable memories (fact/decision/correction/
 *      pitfall) and those are written too.
 *  (c) an "episode" marker tagged "checkpoint" is ALWAYS written, and the caller's capture-pressure
 *      counter is ALWAYS reset (recordCheckpoint) -- this happens even if (a) or (b) partially or
 *      fully failed, because the checkpoint ACT itself (the caller took the time to call this
 *      tool) is what relieves capture pressure, independent of how much got persisted.
 *
 * FAIL-OPEN: an LLM or index error must still write what it can and still reset the counter; this
 * handler never throws out of a distillation/index failure (each memory-write attempt and the
 * distillation call are individually try/caught so ONE bad item never blocks the rest).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { writeMemory } from '../../agentstate/memory.js';
import { MEMORY_KINDS } from '../../agentstate/agents.js';
import { indexMemoryNow } from '../../azure/search-write.js';
import { chat, foundryConfigured, type ChatMessage } from '../../azure/foundry.js';
import { buildEpisodeText } from '../../safety/journal.js';
import { recordCheckpoint } from '../../safety/capture-pressure.js';
import { captureGatewayEvent } from '../../telemetry/gateway-ops.js';

const DISTILL_KINDS = ['fact', 'decision', 'correction', 'pitfall'] as const;
type DistillKind = (typeof DISTILL_KINDS)[number];
const DISTILL_KIND_SET = new Set<string>(DISTILL_KINDS);

interface DistilledMemory {
  kind: DistillKind;
  text: string;
}

const MAX_DISTILLED = 3;
const MAX_DISTILL_TEXT_CHARS = 2000;
const MAX_SUMMARY_INPUT_CHARS = 8000;

const DISTILL_SYSTEM_PROMPT =
  'You extract durable, atomic memories from a session summary for a company memory ledger. ' +
  `Read the summary and produce 0 to ${MAX_DISTILLED} atomic, durable memories worth remembering ` +
  'long term: a fact, a decision, a correction to a prior belief, or a pitfall to avoid repeating. ' +
  'Skip anything that is not durable, such as status chatter, in-progress narration, or routine ' +
  'tool output. Reply with JSON only, in this exact shape: ' +
  '{"memories": [{"kind": "fact|decision|correction|pitfall", "text": "..."}]}. ' +
  'If nothing is durable, reply {"memories": []}. Do not use em dashes or en dashes in the text.';

/**
 * Pure parse of the distillation model's JSON reply into a validated, capped list. Defensive
 * against a malformed/partial/over-long model response (wrong types, extra keys, too many items,
 * an unparseable body). Never throws.
 */
export function parseDistillResponse(raw: string): DistilledMemory[] {
  try {
    const parsed = JSON.parse(raw) as { memories?: unknown };
    const arr = Array.isArray(parsed?.memories) ? parsed.memories : [];
    const out: DistilledMemory[] = [];
    for (const item of arr) {
      if (out.length >= MAX_DISTILLED) break;
      if (!item || typeof item !== 'object') continue;
      const kind = (item as Record<string, unknown>).kind;
      const text = (item as Record<string, unknown>).text;
      if (typeof kind === 'string' && DISTILL_KIND_SET.has(kind) && typeof text === 'string' && text.trim()) {
        out.push({ kind: kind as DistillKind, text: text.trim().slice(0, MAX_DISTILL_TEXT_CHARS) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Call the shared Azure LLM client (azure/foundry.ts) to distill a summary. Throws on transport/
 *  API failure -- the caller wraps this in its own try/catch (fail-open at the call site). */
async function distillSummary(summary: string): Promise<DistilledMemory[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DISTILL_SYSTEM_PROMPT },
    { role: 'user', content: summary.slice(0, MAX_SUMMARY_INPUT_CHARS) },
  ];
  const res = await chat(messages, { maxTokens: 700, jsonMode: true, tier: 'standard' });
  return parseDistillResponse(res.text);
}

/** Write one memory + best-effort write-through index it. Returns the new record id, or null on
 *  any failure (fail-open per item: one bad entry must never block the rest of the checkpoint). */
async function writeAndIndex(
  agent: string,
  kind: (typeof MEMORY_KINDS)[number],
  text: string,
  opts: { tags?: string[]; source?: string; supersedes?: string } = {},
): Promise<string | null> {
  try {
    const record = await writeMemory({ agent, kind, text, tags: opts.tags, source: opts.source, supersedes: opts.supersedes });
    await indexMemoryNow({
      agent: record.agent,
      id: record.id,
      type: record.kind,
      ts: record.created_at,
      tags: record.tags,
      text: record.text,
    });
    return record.id;
  } catch {
    return null;
  }
}

export function registerCheckpoint(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'checkpoint',
      category: 'write_simple',
      annotations: {
        title: 'Checkpoint: distill and persist session memory',
        description:
          'Platform-agnostic session-end capture. ANY engine (Claude Code, ChatGPT, Copilot, Hyperagent) calls this at a natural stopping point, not only the Claude Code Stop hook. Writes any explicit "memories" verbatim, server-side distills an optional freeform "summary" into 0 to 3 atomic durable memories (fact/decision/correction/pitfall) when the credit-funded Azure LLM is configured, always writes an episode marker, and always resets the capture-pressure counter for this caller. Fail-open: an LLM or index error still persists what it can. Pass dry_run=false to actually write. Non-PHI, non-MNPI, non-privileged (clo-personal rejected downstream by normalizeAgent).',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Agent lane to checkpoint (lowercase id, e.g. "cto", "developer").'),
        summary: z
          .string()
          .optional()
          .describe('Optional freeform summary of what happened / what to remember. Server-side distilled into 0-3 atomic memories when the Azure LLM is configured.'),
        memories: z
          .array(
            z.object({
              kind: z.enum(MEMORY_KINDS).describe('fact, decision, correction, pitfall, status, or episode.'),
              text: z.string().min(1).describe('The atomic, non-sensitive memory text.'),
              tags: z.array(z.string()).optional(),
              supersedes: z.string().optional().describe('Optional: the id of an entry this one REPLACES.'),
            }),
          )
          .optional()
          .describe('Optional explicit memories to write verbatim (no LLM involved).'),
      },
      outputShape: {
        written: z.array(z.string()),
        distilled: z.number(),
        checkpoint: z.boolean(),
      },
      handler: async (input, ctx) => {
        if (!isConfigured()) {
          return {
            data: { written: [], distilled: 0, checkpoint: false, note: 'agent-state Cosmos not configured.' },
            summary: 'checkpoint unavailable: agent-state Cosmos not configured on the gateway.',
          };
        }
        const memoriesIn = input.memories ?? [];
        if (ctx.dryRun) {
          return {
            data: {
              written: [],
              distilled: 0,
              checkpoint: false,
              preview: { agent: input.agent, summary: input.summary, memories: memoriesIn },
              note: 'dry_run: nothing written. Pass dry_run=false to persist.',
            },
            summary:
              `DRY RUN: would checkpoint ${input.agent} (${memoriesIn.length} explicit ` +
              `memor${memoriesIn.length === 1 ? 'y' : 'ies'}${input.summary ? ' + a summary distillation' : ''}) ` +
              `and reset capture pressure.`,
          };
        }

        const written: string[] = [];
        let distilled = 0;

        // (a) explicit memories, verbatim -- one failure never blocks the rest.
        for (const m of memoriesIn) {
          const id = await writeAndIndex(input.agent, m.kind, m.text, { tags: m.tags, supersedes: m.supersedes });
          if (id) written.push(id);
        }

        // (b) server-side distillation of the summary, best-effort. A distillation failure (LLM
        // down, malformed reply, Foundry unconfigured) must never fail the checkpoint -- it just
        // distills 0 memories.
        if (input.summary && input.summary.trim() && foundryConfigured()) {
          try {
            const items = await distillSummary(input.summary);
            for (const dm of items) {
              const id = await writeAndIndex(input.agent, dm.kind, dm.text, { tags: ['checkpoint-distilled'], source: 'checkpoint distillation' });
              if (id) {
                written.push(id);
                distilled += 1;
              }
            }
          } catch {
            /* fail-open: a distillation failure must not fail the checkpoint */
          }
        }

        // (c) ALWAYS write an episode marker and ALWAYS reset capture pressure, even if (a)/(b)
        // partially or fully failed above -- the checkpoint ACT is what relieves capture pressure.
        const episodeText = buildEpisodeText({
          tool: 'checkpoint',
          actor: input.agent,
          outcome: 'success',
          redactedArgs: { memories: memoriesIn.length, has_summary: Boolean(input.summary) },
        });
        const episodeId = await writeAndIndex(input.agent, 'episode', episodeText, {
          tags: ['checkpoint'],
          source: `correlation:${ctx.correlationId}`,
        });
        if (episodeId) written.push(episodeId);
        recordCheckpoint(ctx.callerHash);

        // PHASE 2 SLO TELEMETRY (observe-only): the numerator for the capture-rate SLO
        // (gw_checkpoint / gw_mutation, computed downstream in PostHog). Only reached on a real
        // (non-dry-run) checkpoint -- the dry_run branch returns early above. captureGatewayEvent is
        // fire-and-forget, inert unless POSTHOG_GATEWAYOPS_KEY is set, and never throws, so it cannot
        // add latency or a new failure mode to this response.
        captureGatewayEvent('gw_checkpoint', { agent: input.agent, written: written.length, distilled }, ctx.callerHash);

        return {
          data: { written, distilled, checkpoint: true },
          summary:
            `checkpoint(${input.agent}): wrote ${written.length} memor${written.length === 1 ? 'y' : 'ies'}` +
            ` (${distilled} distilled from summary). Capture pressure reset.`,
          audit: { after: { agent: input.agent, written, distilled } },
        };
      },
    },
    callerHash,
  );
}
