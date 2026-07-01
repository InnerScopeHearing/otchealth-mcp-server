import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured } from '../../agentstate/cosmos.js';
import { searchMemory } from '../../agentstate/memory.js';
import { MEMORY_KINDS } from '../../agentstate/agents.js';

export function registerMemorySearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_search',
      category: 'read',
      annotations: {
        title: 'Search the structured memory-of-record',
        description:
          'Deterministic keyword/field search over the Cosmos memory store (by agent, kind, and/or a text substring). This is exact recall of the byte-exact record. For meaning-based semantic recall across all rooms, use the company-brain instead.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().optional().describe('Filter by agent lane.'),
        kind: z.enum(MEMORY_KINDS).optional().describe('Filter by kind.'),
        contains: z.string().optional().describe('Case-insensitive substring match on the text.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
      },
      outputShape: { count: z.number(), records: z.unknown() },
      handler: async (input) => {
        if (!isConfigured()) return { data: { count: 0, records: [], note: 'agent-state Cosmos not configured.' }, summary: 'Memory store not configured.' };
        const records = await searchMemory(input);
        return { data: { count: records.length, records }, summary: `${records.length} memory record(s).` };
      },
    },
    callerHash,
  );
}
