import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getOffering } from '../../revenuecat/full-client.js';

export function registerRevenueCatOfferingGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_offering_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat offering',
      description: 'Fetch a single offering by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      offering_id: z.string().describe('Offering ID'),
    },
    outputShape: { offering: z.unknown() },
    handler: async (input) => {
      const offering = await getOffering(input.project_id, input.offering_id);
      return { data: { offering }, summary: `Offering: ${offering?.lookup_key ?? input.offering_id}` };
    },
  }, callerHash);
}
