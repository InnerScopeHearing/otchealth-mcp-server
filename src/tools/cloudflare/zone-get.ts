import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getZone } from '../../cloudflare/full-client.js';

export function registerCloudflareZoneGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_zone_get',
    category: 'read',
    annotations: {
      title: 'Get Cloudflare zone',
      description: 'Retrieve details for a single zone. Defaults to CLOUDFLARE_ZONE_ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      zone: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const zone = await getZone(input.zone_id);
      return {
        data: { zone },
        summary: `Zone: ${(zone as any)?.name ?? input.zone_id}`,
      };
    },
  }, callerHash);
}
