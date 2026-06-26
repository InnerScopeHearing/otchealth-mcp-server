import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getWorkersRoute } from '../../cloudflare/full-client.js';

export function registerCloudflareWorkersRouteGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_workers_route_get',
    category: 'read',
    annotations: {
      title: 'Get Workers route',
      description: 'Retrieve a single Workers route by its ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      route_id: z.string().describe('Workers route ID.'),
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      route: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const route = await getWorkersRoute(input.route_id, input.zone_id);
      return {
        data: { route },
        summary: `Route ${input.route_id}: pattern=${(route as any)?.pattern ?? 'unknown'}`,
      };
    },
  }, callerHash);
}
