import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listWorkersRoutes } from '../../cloudflare/full-client.js';

export function registerCloudflareWorkersRouteList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_workers_route_list',
    category: 'read',
    annotations: {
      title: 'List Workers routes',
      description: 'List all Workers route bindings (URL patterns to script mappings) for a zone.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      zone_id: z.string().optional().describe('Zone ID (defaults to CLOUDFLARE_ZONE_ID env var).'),
    },
    outputShape: {
      routes: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const routes = await listWorkersRoutes(input.zone_id);
      return {
        data: { routes, count: routes.length },
        summary: `Found ${routes.length} Workers route(s).`,
      };
    },
  }, callerHash);
}
