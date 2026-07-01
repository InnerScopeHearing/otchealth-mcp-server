import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { writeMemory } from '../../agentstate/memory.js';
import { MEMORY_KINDS } from '../../agentstate/agents.js';

export function registerMemoryWrite(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_write',
      category: 'write_simple',
      annotations: {
        title: 'Write a structured memory-of-record',
        description:
          'Write a durable, byte-exact, queryable memory record (fact/decision/correction/pitfall/status) to the Cosmos memory store. This is the verbatim system-of-record for memory: never lossy, never LLM-rewritten. Non-PHI, non-MNPI, non-privileged (clo-personal rejected). Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Agent lane (lowercase id).'),
        kind: z.enum(MEMORY_KINDS).describe('fact, decision, correction, pitfall, or status.'),
        text: z.string().min(1).describe('The atomic, non-sensitive memory text.'),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe('Optional attribution, e.g. "Matt 2026-07-01".'),
      },
      outputShape: { written: z.boolean(), record: z.unknown() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { written: false, note: 'agent-state Cosmos not configured.' }, summary: 'Memory store not configured.' };
        if (ctx.dryRun) return { data: { written: false, preview: input, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would write a ${input.kind} for ${input.agent}.` };
        const record = await writeMemory(input);
        return { data: { written: true, record }, summary: `Wrote ${input.kind} ${record.id} to ${input.agent}'s memory-of-record.`, audit: { after: record } };
      },
    },
    callerHash,
  );
}
