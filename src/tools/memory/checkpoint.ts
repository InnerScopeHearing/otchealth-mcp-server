/** Checkpoint preserves confirmed writes and reports storage/index delivery separately.
 * Partial delivery must not reset capture pressure or count as a successful checkpoint.
 * Individual failures do not prevent remaining entries from being attempted.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/store.js';
import { writeMemory, recordMemoryIndexOutcome } from '../../agentstate/memory.js';
import { MEMORY_KINDS } from '../../agentstate/agents.js';
import { indexMemory as indexMemoryNow } from '../../search/index.js';
import { chat, chatConfigured, type ChatMessage } from '../../azure/foundry.js';
import { buildEpisodeText } from '../../safety/journal.js';
import { recordCheckpoint } from '../../safety/capture-pressure.js';
import { captureGatewayEvent } from '../../telemetry/gateway-ops.js';
import { evaluateBroadcastMnpiGate } from '../../safety/mnpi-gate.js';
import { deliverCheckpointMemory, checkpointDeliveryStatus, type Delivery } from './checkpoint-delivery.js';

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

/**
 * Call the shared LLM provider dispatcher (azure/foundry.ts) to distill a summary. Throws on transport/
 * API failure -- the caller wraps this in its own try/catch (fail-open at the call site).
 *
 * Tier: 'router' -- this is a bounded extraction task (a strict-JSON list of 0-3 short atomic
 * memories, capped output, always parsed defensively by parseDistillResponse which fails safe to
 * an empty list on anything malformed), the same task shape the fleet's own llm_azure tool already
 * lets external callers route through the Azure Model Router. Asking the router to pick the
 * cheapest-sufficient model here is the FLEET COST PROTOCOL applied to an internal call site that
 * previously hardcoded a static tier itself. When FOUNDRY_ROUTER_ENDPOINT/KEY are unset, chat()
 * degrades this to the exact same 'standard' deployment used before this change (see foundry.ts).
 */
export async function distillSummary(summary: string): Promise<DistilledMemory[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DISTILL_SYSTEM_PROMPT },
    { role: 'user', content: summary.slice(0, MAX_SUMMARY_INPUT_CHARS) },
  ];
  const res = await chat(messages, { maxTokens: 700, jsonMode: true, tier: 'router' });
  // A malformed reply is not evidence that the summary contains no durable facts.
  let envelope: unknown;
  try { envelope = JSON.parse(res.text); } catch { throw new Error('checkpoint_distillation_invalid'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).join(',') !== 'memories') throw new Error('checkpoint_distillation_invalid');
  const memories = (envelope as { memories: unknown }).memories;
  if (!Array.isArray(memories) || memories.length > MAX_DISTILLED || memories.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item) ||
    Object.keys(item).sort().join(',') !== 'kind,text' || !DISTILL_KIND_SET.has(item.kind) ||
    typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_DISTILL_TEXT_CHARS)) {
    throw new Error('checkpoint_distillation_invalid');
  }
  return parseDistillResponse(res.text);
}

/** Write one memory and report confirmed storage separately from best-effort indexing. On
 *  any failure (fail-open per item: one bad entry must never block the rest of the checkpoint). */
async function writeAndIndex(
  agent: string,
  kind: (typeof MEMORY_KINDS)[number],
  text: string,
  opts: { tags?: string[]; source?: string; supersedes?: string } = {},
): Promise<Delivery> {
  return deliverCheckpointMemory(
    () => writeMemory({ agent, kind, text, tags: opts.tags, source: opts.source, supersedes: opts.supersedes }),
    async record => {
      const indexed = await indexMemoryNow({
        agent: record.agent,
        id: record.id,
        type: record.kind,
        ts: record.created_at,
        tags: record.tags,
        text: record.text,
      });
      await recordMemoryIndexOutcome(record, indexed.indexed).catch(() => undefined);
      return indexed;
    },
  );
}

type CheckpointDependencies = {
  register: typeof registerTool;
  configured: typeof isConfigured;
  deliver: typeof writeAndIndex;
  reset: typeof recordCheckpoint;
};

export function registerCheckpoint(server: McpServer, callerHash: CallerHashProvider,
  overrides: Partial<CheckpointDependencies> = {}): void {
  const deps: CheckpointDependencies = { register: registerTool, configured: isConfigured,
    deliver: writeAndIndex, reset: recordCheckpoint, ...overrides };
  deps.register(
    server,
    {
      name: 'checkpoint',
      category: 'write_simple',
      annotations: {
        title: 'Checkpoint: distill and persist session memory',
        description:
          'Platform-agnostic session-end capture. ANY engine (Claude Code, ChatGPT, Copilot, Hyperagent) calls this at a natural stopping point, not only the Claude Code Stop hook. Writes up to 20 explicit "memories" verbatim (sequentially, one write+index per entry -- this is for a handful of session takeaways, not a bulk import), server-side distills an optional freeform "summary" into 0 to 3 atomic durable memories (fact/decision/correction/pitfall) when the selected LLM provider is configured, attempts an episode marker, and resets capture pressure only when delivery is confirmed. Partial failure preserves confirmed IDs and reports indexing and unconfirmed storage separately; do not blindly repeat stored memories. Pass dry_run=false to actually write. Non-PHI, non-MNPI, non-privileged (clo-personal rejected downstream by normalizeAgent). MNPI GATE (hard, code-level, not fail-open like the rest of this tool): summary + every explicit memory text are scanned for an EXEC_RING-gated room reference or an explicit MNPI marker BEFORE anything is written; a match refuses the ENTIRE checkpoint call, because this record is write-through indexed into memory-exec, a room every agent reaches.',
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
          .describe('Optional freeform summary of what happened / what to remember. Server-side distilled into 0-3 atomic memories when the selected LLM provider is configured.'),
        // Capped at 20 (FND-20260829-e454): each entry writes+indexes SEQUENTIALLY (one Cosmos
        // write + one AI Search index call per item, never batched -- see the handler's `for`
        // loop below), and this array had no bound at all before. A well-formed checkpoint call
        // ("atomic, non-sensitive memory text" -- this is meant for a session's key takeaways, not
        // a bulk import) never approaches 20; the cap exists so a caller cannot turn one checkpoint
        // call into dozens of sequential network round trips well past a 45-second-class MCP client
        // timeout.
        memories: z
          .array(
            z.object({
              kind: z.enum(MEMORY_KINDS).describe('fact, decision, correction, pitfall, status, or episode.'),
              text: z.string().min(1).describe('The atomic, non-sensitive memory text.'),
              tags: z.array(z.string()).optional(),
              supersedes: z.string().optional().describe('Optional: the id of an entry this one REPLACES.'),
            }),
          )
          .max(20)
          .optional()
          .describe('Optional explicit memories to write verbatim (no LLM involved). Max 20 -- this is for a handful of atomic session takeaways, not a bulk import.'),
      },
      outputShape: {
        written: z.array(z.string()),
        distilled: z.number(),
        checkpoint: z.boolean(),
        indexed: z.array(z.string()).optional(),
        unindexed: z.array(z.string()).optional(),
        storage_unconfirmed: z.number().optional(),
        distillation_complete: z.boolean().optional(),
      },
      handler: async (input, ctx) => {
        // MNPI DETERMINISTIC PRE-SHARE GATE (Wave 3 item 3.5, safety/mnpi-gate.ts). Runs BEFORE any
        // write, over the summary AND every explicit memory's text. Unlike the rest of this handler
        // (deliberately fail-open per its own doc comment), this check is a HARD BLOCK for every
        // caller on a match: the underlying store is the same memory-exec room memory_write and
        // memory_remember write into, always broadly recallable, never a legitimate MNPI destination.
        const memoriesText = (input.memories ?? []).map((m) => m.text).join('\n');
        const mnpiGate = evaluateBroadcastMnpiGate({ summary: input.summary, memories_text: memoriesText });
        if (mnpiGate.blocked) {
          return {
            data: { written: [], distilled: 0, checkpoint: false, note: mnpiGate.reason },
            summary: `Refused: ${mnpiGate.reason}`,
          };
        }
        if (!deps.configured()) {
          return {
            data: { written: [], distilled: 0, checkpoint: false, note: 'selected agent-state backend not configured.' },
            summary: 'checkpoint unavailable: selected agent-state backend not configured on the gateway.',
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

        const deliveries: Delivery[] = [];
        let distilled = 0;
        let distillationComplete = !input.summary?.trim() || chatConfigured();

        // (a) explicit memories, verbatim -- one failure never blocks the rest.
        for (const m of memoriesIn) {
          deliveries.push(await deps.deliver(input.agent, m.kind, m.text, { tags: m.tags, supersedes: m.supersedes }));
        }

        // (b) server-side distillation of the summary, best-effort. A distillation failure (LLM
        // down, malformed reply, the chat provider unconfigured) must never fail the checkpoint --
        // it just distills 0 memories.
        if (input.summary && input.summary.trim() && chatConfigured()) {
          try {
            const items = await distillSummary(input.summary);
            for (const dm of items) {
              const delivery = await deps.deliver(input.agent, dm.kind, dm.text, { tags: ['checkpoint-distilled'], source: 'checkpoint distillation' });
              deliveries.push(delivery);
              if (delivery.stored) {
                distilled += 1;
              }
            }
          } catch {
            distillationComplete = false;
          }
        }

        // (c) Attempt an episode marker after the entries. Only confirmed complete delivery resets pressure.
        // An episode alone cannot hide a failed explicit memory or requested distillation.
        const episodeText = buildEpisodeText({
          tool: 'checkpoint',
          actor: input.agent,
          outcome: distillationComplete && deliveries.every(item => item.stored && item.indexed) ? 'delivery_pending_episode' : 'partial',
          redactedArgs: { memories: memoriesIn.length, has_summary: Boolean(input.summary) },
        });
        const episode = await deps.deliver(input.agent, 'episode', episodeText, {
          tags: ['checkpoint'],
          source: `correlation:${ctx.correlationId}`,
        });
        deliveries.push(episode);
        const deliveryStatus = checkpointDeliveryStatus(deliveries);
        const { written } = deliveryStatus;
        const checkpoint = deliveryStatus.checkpoint && distillationComplete;
        if (checkpoint) deps.reset(ctx.callerHash);

        // PHASE 2 SLO TELEMETRY (observe-only): the numerator for the capture-rate SLO
        // (gw_checkpoint / gw_mutation, computed downstream in PostHog). Only reached on a real
        // (non-dry-run) checkpoint -- the dry_run branch returns early above. captureGatewayEvent is
        // fire-and-forget, inert unless POSTHOG_GATEWAYOPS_KEY is set, and never throws, so it cannot
        // add latency or a new failure mode to this response.
        if (checkpoint) captureGatewayEvent('gw_checkpoint', { agent: input.agent, written: written.length, distilled }, ctx.callerHash);

        return {
          data: { ...deliveryStatus, distilled, checkpoint, distillation_complete: distillationComplete },
          summary:
            `checkpoint(${input.agent}): wrote ${written.length} memor${written.length === 1 ? 'y' : 'ies'}` +
            ` (${distilled} distilled from summary). ` + (checkpoint ? 'Capture pressure reset.' : 'Delivery incomplete; capture pressure retained. Preserve written IDs, do not blindly repeat stored memories.'),
          audit: { after: { agent: input.agent, written, distilled } },
        };
      },
    },
    callerHash,
  );
}
