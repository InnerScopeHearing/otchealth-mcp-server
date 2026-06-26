import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEntitlement } from '../../revenuecat/full-client.js';

export function registerRevenueCatEntitlementGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_entitlement_get',
    category: 'read',
    annotations: {
      title: 'Get RevenueCat entitlement',
      description: 'Fetch a single entitlement definition by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      entitlement_id: z.string().describe('Entitlement ID'),
    },
    outputShape: { entitlement: z.unknown() },
    handler: async (input) => {
      const entitlement = await getEntitlement(input.project_id, input.entitlement_id);
      return { data: { entitlement }, summary: `Entitlement: ${entitlement?.lookup_key ?? input.entitlement_id}` };
    },
  }, callerHash);
}
