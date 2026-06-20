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
          'Append an entry to the cross-agent shared memory (kb-memory commons feed) so every connected AI sees it. Use for a fact, decision, correction, pitfall, or status. This writes ONLY to the shared, non-sensitive commons feed: never put MNPI (INND), PHI (MedReview), or privileged (legal) detail here. The privilege-walled "clo-personal" lane is rejected.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z
          .string()
          .describe('The agent lane to publish under (lowercase id, e.g. "cto", "cfo", "commerce", "haulai").'),
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
        const agent = normalizeAgent(input.agent);
        if (ctx.dryRun) {
          const preview: Omit<MemoryEntry, 'id' | 'ts'> = {
            type: input.type,
            text: input.text,
            tags: input.tags ?? [],
            agent,
            ...(input.source ? { source: input.source } : {}),
          };
          return {
            data: { written: false, entry: preview, note: 'dry_run: not written. Pass dry_run=false to persist.' },
            summary: `DRY RUN: would publish a ${input.type} to ${agent}'s shared feed.`,
          };
        }
        const entry = await appendShared(agent, input.type, input.text, input.tags ?? [], input.source);
        return {
          data: { written: true, entry },
          summary: `Published ${input.type} ${entry.id} to ${agent}'s shared feed (id ${entry.id}).`,
          audit: { after: entry },
        };
      },
    },
    callerHash,
  );
}
