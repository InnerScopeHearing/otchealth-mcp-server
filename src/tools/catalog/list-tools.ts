import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  registerTool,
  getRegisteredTools,
  categoryIsWrite,
  type CallerHashProvider,
} from '../registry.js';

/**
 * Derive a service name from a tool name. Tools are named `<service>_<verb...>`,
 * e.g. cio_* -> customerio, shopify_* -> shopify. cio is the one alias.
 */
function serviceOf(toolName: string): string {
  const prefix = toolName.split('_')[0] ?? 'other';
  if (prefix === 'cio') return 'customerio';
  return prefix;
}

export function registerCatalogListTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'catalog_list_tools',
      category: 'read',
      annotations: {
        title: 'List every gateway tool (grouped by service)',
        description:
          'Enumerate every tool this gateway exposes, grouped by upstream service, with a params summary and read/write/destructive gating. The catalog so agents always pick the right tool.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        service: z.string().optional().describe('Filter to one service (e.g. depot, posthog, customerio).'),
      },
      outputShape: {
        services: z.array(z.unknown()),
        tool_count: z.number(),
      },
      handler: async (input, _ctx) => {
        const filter = input.service?.trim().toLowerCase();
        const grouped = new Map<
          string,
          Array<{
            name: string;
            title: string;
            description: string;
            access: 'read' | 'write' | 'destructive';
            params: string[];
          }>
        >();
        let total = 0;
        for (const t of getRegisteredTools()) {
          const svc = serviceOf(t.name);
          if (filter && svc !== filter) continue;
          total += 1;
          const access: 'read' | 'write' | 'destructive' = t.destructive
            ? 'destructive'
            : categoryIsWrite(t.category)
              ? 'write'
              : 'read';
          if (!grouped.has(svc)) grouped.set(svc, []);
          grouped.get(svc)!.push({
            name: t.name,
            title: t.title,
            description: t.description,
            access,
            params: t.params,
          });
        }
        const services = [...grouped.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([service, tools]) => ({ service, tool_count: tools.length, tools }));
        return {
          data: { services, tool_count: total },
          summary: `${total} tool(s) across ${services.length} service(s).`,
        };
      },
    },
    callerHash,
  );
}
