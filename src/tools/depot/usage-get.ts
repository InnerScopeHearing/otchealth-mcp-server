import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProjectUsage } from '../../depot/full-client.js';

export function registerDepotUsageGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_usage_get',
    category: 'read',
    annotations: {
      title: 'Depot: get project usage',
      description: 'Get detailed build compute usage for a single Depot project. Critical for cost monitoring — macOS builders cost ~10x Linux. Includes compute minutes, cache usage. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      start_time: z.string().optional().describe('RFC 3339 start time. Defaults to 30 days ago.'),
      end_time: z.string().optional().describe('RFC 3339 end time. Defaults to now.'),
    },
    outputShape: {
      usage: z.unknown(),
    },
    handler: async (input) => {
      const result = await getProjectUsage({
        projectId: input.project_id,
        startTime: input.start_time,
        endTime: input.end_time,
      });
      return {
        data: { usage: result?.usage ?? result },
        summary: `Usage data for Depot project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
