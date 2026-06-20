import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, readSharedAll, type MemoryEntry } from '../../memory/store.js';

export function registerMemoryTeam(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_team',
      category: 'read',
      annotations: {
        title: 'Read the team picture',
        description:
          'The company-wide view from the shared brain: the latest status per agent (what each is working on) plus the most recent shared facts and decisions across the whole exec team. Run this on wake to see what everyone is doing before acting.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        limit: z.number().int().min(1).max(100).optional().describe('Max recent shared entries to return (default 40).'),
      },
      outputShape: {
        current_status: z.array(z.unknown()),
        recent: z.array(z.unknown()),
        agents: z.array(z.string()),
        shared_entry_count: z.number(),
      },
      handler: async (input) => {
        if (!isConfigured()) {
          return {
            data: { current_status: [], recent: [], agents: [], shared_entry_count: 0 },
            summary: 'Shared brain not configured.',
          };
        }
        const limit = input.limit ?? 40;
        const all = await readSharedAll();
        const latestStatus = new Map<string, MemoryEntry>();
        for (const r of all) {
          if (r.type === 'status' && !latestStatus.has(r.agent)) latestStatus.set(r.agent, r);
        }
        const current = [...latestStatus.values()].sort((a, b) => a.agent.localeCompare(b.agent));
        return {
          data: {
            current_status: current,
            recent: all.slice(0, limit),
            agents: [...new Set(all.map((r) => r.agent))].sort(),
            shared_entry_count: all.length,
          },
          summary: `${current.length} agent(s) with status; ${all.length} shared entries total.`,
        };
      },
    },
    callerHash,
  );
}
