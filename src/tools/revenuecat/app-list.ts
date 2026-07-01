import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listApps } from '../../revenuecat/full-client.js';

export function registerRevenueCatAppList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_app_list',
    category: 'read',
    annotations: {
      title: 'List RevenueCat apps',
      description: 'List all apps (stores) within a RevenueCat project.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (1-100)'),
    },
    outputShape: { apps: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await listApps(input.project_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.apps ?? [];
      return { data: { apps: items, count: items.length }, summary: `${items.length} app(s) in project ${input.project_id}.` };
    },
  }, callerHash);
}
