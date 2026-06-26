import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEmailCatchAll } from '../../cloudflare/full-client.js';

export function registerCloudflareEmailRoutingGetCatchAll(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_email_routing_get_catch_all',
    category: 'read',
    annotations: {
      title: 'Get email catch-all rule',
      description: 'Retrieve the catch-all email routing rule (action for unmatched email).',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      catch_all: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const catchAll = await getEmailCatchAll(input.zone_id);
      return {
        data: { catch_all: catchAll },
        summary: `Catch-all enabled: ${(catchAll as any)?.enabled ?? 'unknown'}, action: ${(catchAll as any)?.actions?.[0]?.type ?? 'unknown'}`,
      };
    },
  }, callerHash);
}
