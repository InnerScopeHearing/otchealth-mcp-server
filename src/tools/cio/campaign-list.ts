import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCampaigns } from '../../customerio/full-client.js';

export function registerCioCampaignList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_campaign_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io campaigns',
      description: 'List all campaigns (broadcast and triggered) in the Customer.io workspace via App API GET /campaigns. Returns campaign metadata including ID, name, type, and state.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of campaigns to return (default 50).'),
      start_after: z.number().int().optional().describe('Cursor for pagination — the last campaign ID from the previous page.'),
    },
    outputShape: {
      campaigns: z.unknown(),
    },
    handler: async (input, ctx) => {
      const result = await listCampaigns({ limit: input.limit, start_after: input.start_after, correlationId: ctx.correlationId });
      return { data: { campaigns: result } };
    },
  }, callerHash);
}
