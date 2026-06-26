import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listZones } from '../../cloudflare/full-client.js';

export function registerCloudflareZoneList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_zone_list',
    category: 'read',
    annotations: {
      title: 'List Cloudflare zones',
      description: 'List all zones on the Cloudflare account. Optionally filter by name or status.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      name: z.string().optional().describe('Filter by zone name (exact or partial).'),
      status: z.enum(['active', 'pending', 'initializing', 'moved', 'deleted', 'deactivated']).optional().describe('Filter by zone status.'),
      per_page: z.number().int().optional().describe('Results per page (max 50).'),
      page: z.number().int().optional().describe('Page number.'),
    },
    outputShape: {
      zones: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const zones = await listZones(input);
      return {
        data: { zones, count: zones.length },
        summary: `Found ${zones.length} zone(s).`,
      };
    },
  }, callerHash);
}
