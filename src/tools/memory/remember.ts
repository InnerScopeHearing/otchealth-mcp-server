import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appendShared, isConfigured, normalizeAgent, type MemoryEntry } from '../../memory/store.js';

const TYPES = ['fact', 'decision', 'correction', 'pitfall', 'status'] as const;

export function registerMemoryRemember(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_remember',
      category: 'write_simple',
      annotations: {
        title: 'Write to the shared brain',
        description:
          'Append an entry to the cross-agent shared memory (kb-memory commons feed) so every connected AI sees it. Use for a fact, decision, correction, pitfall, or status. Set "agent" to write ON ANOTHER lane\'s feed (a cross-lane note / hand-off): it is APPEND-ONLY and auto-attributed to YOUR token identity (by=<you>), and the target lane sees it via memory_inbound and acks with memory_reconcile on wake. Omit "agent" to write your own feed. Writes ONLY to the shared, non-sensitive commons feed: never put MNPI (INND), PHI (MedReview), or privileged (legal) detail here. The privilege-walled "clo-personal" lane is rejected.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z
          .string()
          .optional()
          .describe('The agent lane to publish under; defaults to your token identity (lowercase id, e.g. "cto", "commerce").'),
        type: z.enum(TYPES).describe('Entry kind: fact, decision, correction, pitfall, or status.'),
        text: z.string().min(1).describe('The fact/decision/correction/pitfall/status text. Keep it atomic and non-sensitive.'),
        tags: z.array(z.string()).optional().describe('Optional tags for recall, e.g. ["ebay","pricing"].'),
        source: z.string().optional().describe('Optional attribution, e.g. "Matt 2026-06-20".'),
      },
      outputShape: {
        written: z.boolean(),
        entry: z.unknown(),
        note: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isConfigured()) {
          return {
            data: { written: false, entry: null, note: 'Shared brain not configured (AZURE_COMMONS_STORAGE_ACCOUNT/KEY unset).' },
            summary: 'Memory store not configured; nothing written.',
          };
        }
        const agent = normalizeAgent(input.agent || ctx.callerAgent);
        // The WRITER is the authenticated caller (from the token), never a spoofable param. When the
        // target feed (agent) differs from the writer, it's an attributed, append-only CROSS-LANE note.
        let by = '';
        try { by = ctx.callerAgent ? normalizeAgent(ctx.callerAgent) : ''; } catch { by = ''; }
        const cross = Boolean(by && by !== agent);
        if (ctx.dryRun) {
          const preview: Omit<MemoryEntry, 'id' | 'ts'> = {
            type: input.type,
            text: input.text,
            tags: input.tags ?? [],
            agent,
            ...(input.source ? { source: input.source } : {}),
            ...(cross ? { by } : {}),
          };
          return {
            data: { written: false, entry: preview, note: 'dry_run: not written. Pass dry_run=false to persist.' },
            summary: cross ? `DRY RUN: would write a cross-lane ${input.type} BY ${by} ON ${agent}'s feed.` : `DRY RUN: would publish a ${input.type} to ${agent}'s shared feed.`,
          };
        }
        const entry = await appendShared(agent, input.type, input.text, input.tags ?? [], input.source, by || undefined);
        return {
          data: { written: true, entry },
          summary: cross
            ? `Cross-lane ${input.type} ${entry.id} written BY ${by} ON ${agent}'s feed (append-only, attributed). ${agent} sees it via memory_inbound on next wake.`
            : `Published ${input.type} ${entry.id} to ${agent}'s shared feed (id ${entry.id}).`,
          audit: { after: entry },
        };
      },
    },
    callerHash,
  );
}
