import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEmailRoutingDestinations } from '../../cloudflare/api-client.js';

export function registerCloudflareListEmailDestinations(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_list_email_destinations',
    category: 'read',
    annotations: {
      title: 'List Cloudflare email routing destinations',
      description: 'List all verified and pending destination email addresses for email routing on the zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      destinations: z.array(z.object({
        email: z.string(),
        verified: z.boolean().optional(),
        tag: z.string().optional(),
      })),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const destinations = await listEmailRoutingDestinations();
      return {
        data: {
          destinations: destinations.map((d: any) => ({ email: d.email, verified: d.verified ?? null, tag: d.tag ?? null })),
          count: destinations.length,
        },
        summary: `Found ${destinations.length} email routing destination(s).`,
      };
    },
  }, callerHash);
}
