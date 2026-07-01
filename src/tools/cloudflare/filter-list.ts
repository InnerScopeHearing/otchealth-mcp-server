import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listFilters } from '../../cloudflare/full-client.js';

export function registerCloudflareFilterList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_filter_list',
    category: 'read',
    annotations: {
      title: 'List firewall filters',
      description: 'List all legacy firewall filter expressions for a zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      filters: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const filters = await listFilters(input.zone_id);
      return {
        data: { filters, count: filters.length },
        summary: `Found ${filters.length} filter(s).`,
      };
    },
  }, callerHash);
}
