import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getZoneSettings } from '../../cloudflare/full-client.js';

export function registerCloudflareZoneGetSettings(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_zone_get_settings',
    category: 'read',
    annotations: {
      title: 'Get zone settings',
      description: 'Retrieve all settings (SSL mode, caching level, minify, etc.) for a zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      settings: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const settings = await getZoneSettings(input.zone_id);
      return {
        data: { settings, count: settings.length },
        summary: `Retrieved ${settings.length} zone setting(s).`,
      };
    },
  }, callerHash);
}
