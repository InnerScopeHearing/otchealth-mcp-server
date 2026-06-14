import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTools } from '../../catalog/catalog.js';

export function registerCatalogListTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'catalog_list_tools',
    category: 'read',
    annotations: {
      title: 'List gateway tools',
      description: 'Self-describe the gateway: every wired tool grouped by service, with category and read/write lane. Optionally filter to one service. Use this to discover what the gateway can do before calling anything.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    },
    inputShape: {
      service: z.string().optional().describe('Filter to a single service (e.g. "stripe", "cloudflare").'),
    },
    outputShape: {
      services: z.array(z.object({
        service: z.string(),
        tool_count: z.number(),
        tools: z.array(z.object({
          name: z.string(),
          category: z.string(),
          read_only: z.boolean(),
          title: z.string(),
        })),
      })),
      total_tools: z.number(),
      total_services: z.number(),
    },
    handler: async (input, _ctx) => {
      const services = listTools(input.service);
      const total = services.reduce((acc, s) => acc + s.tool_count, 0);
      return {
        data: { services, total_tools: total, total_services: services.length },
        summary: `${total} tool(s) across ${services.length} service(s)${input.service ? ` (filtered to ${input.service})` : ''}.`,
      };
    },
  }, callerHash);
}
