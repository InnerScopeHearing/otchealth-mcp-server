import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEmailRoutingSettings } from '../../cloudflare/full-client.js';

export function registerCloudflareEmailRoutingGetSettings(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_email_routing_get_settings',
    category: 'read',
    annotations: {
      title: 'Get email routing settings',
      description: 'Retrieve email routing configuration (enabled status, etc.) for the zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      settings: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const settings = await getEmailRoutingSettings(input.zone_id);
      return {
        data: { settings },
        summary: `Email routing enabled: ${(settings as any)?.enabled ?? 'unknown'}`,
      };
    },
  }, callerHash);
}
