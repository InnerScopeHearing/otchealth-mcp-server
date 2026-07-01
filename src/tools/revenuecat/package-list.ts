import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPackages } from '../../revenuecat/full-client.js';

export function registerRevenueCatPackageList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_package_list',
    category: 'read',
    annotations: {
      title: 'List packages in offering',
      description: 'List all packages within a RevenueCat offering.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Offering ID'),
      starting_after: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size'),
    },
    outputShape: { packages: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const r: any = await listPackages(input.project_id, input.offering_id, { starting_after: input.starting_after, limit: input.limit });
      const items = r.items ?? r.packages ?? [];
      return { data: { packages: items, count: items.length }, summary: `${items.length} package(s) in offering ${input.offering_id}.` };
    },
  }, callerHash);
}
