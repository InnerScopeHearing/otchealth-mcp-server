import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getUsage } from '../../depot/full-client.js';

export function registerDepotUsageOrgGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_usage_org_get',
    category: 'read',
    annotations: {
      title: 'Depot: get organization usage',
      description: 'Get aggregate build compute usage for the entire Depot organization over a time window. Use for spend audits and burn-rate monitoring (macOS ~10x cost amplifier). Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      start_time: z.string().optional().describe('RFC 3339 start time. Defaults to 30 days ago.'),
      end_time: z.string().optional().describe('RFC 3339 end time. Defaults to now.'),
    },
    outputShape: {
      usage: z.unknown(),
    },
    handler: async (input) => {
      const result = await getUsage({
        startTime: input.start_time,
        endTime: input.end_time,
      });
      return {
        data: { usage: result?.usage ?? result },
        summary: 'Organization-level Depot usage data fetched.',
      };
    },
  }, callerHash);
}
