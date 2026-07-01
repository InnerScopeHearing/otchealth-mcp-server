import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getFilter } from '../../cloudflare/full-client.js';

export function registerCloudflareFilterGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_filter_get',
    category: 'read',
    annotations: {
      title: 'Get firewall filter',
      description: 'Retrieve a single legacy firewall filter expression by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      filter_id: z.string().describe('Filter ID.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      filter: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const filter = await getFilter(input.filter_id, input.zone_id);
      return {
        data: { filter },
        summary: `Filter ${input.filter_id}: ${(filter as any)?.expression ?? ''}`,
      };
    },
  }, callerHash);
}
