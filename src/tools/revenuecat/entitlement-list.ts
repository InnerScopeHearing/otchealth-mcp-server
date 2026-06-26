import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEntitlements } from '../../revenuecat/full-client.js';

export function registerRevenueCatEntitlementList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_entitlement_list',
    category: 'read',
    annotations: {
      title: 'List RevenueCat entitlements',
      description: 'List all entitlement definitions in a project.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size'),
    },
    outputShape: { entitlements: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await listEntitlements(input.project_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.entitlements ?? [];
      return { data: { entitlements: items, count: items.length }, summary: `${items.length} entitlement(s).` };
    },
  }, callerHash);
}
