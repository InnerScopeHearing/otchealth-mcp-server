import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listProjectUsage } from '../../depot/full-client.js';

export function registerDepotUsageList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_usage_list',
    category: 'read',
    annotations: {
      title: 'Depot: list usage across projects',
      description: 'List build compute usage across all Depot projects for a time range. Critical for monitoring macOS ~10x cost amplification. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      start_time: z.string().optional().describe('RFC 3339 start time (e.g. "2026-06-01T00:00:00Z"). Defaults to 30 days ago.'),
      end_time: z.string().optional().describe('RFC 3339 end time. Defaults to now.'),
    },
    outputShape: {
      projects: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const result = await listProjectUsage({
        startTime: input.start_time,
        endTime: input.end_time,
      });
      const projects = result?.projects ?? result?.usage ?? [];
      return {
        data: { projects, count: projects.length },
        summary: `Usage data for ${projects.length} project(s).`,
      };
    },
  }, callerHash);
}
