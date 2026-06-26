import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCustomer } from '../../revenuecat/full-client.js';

export function registerRevenueCatCustomerCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'revenuecat_customer_create',
    category: 'write_simple',
    annotations: {
      title: 'Create RevenueCat customer',
      description: 'Create a new customer record in RevenueCat. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('RevenueCat project ID'),
      app_user_id: z.string().describe('App user ID (unique identifier for the customer)'),
    },
    outputShape: { executed: z.boolean(), dry_run: z.boolean(), customer: z.unknown().optional() },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, customer: undefined },
          audit: { before: null, after: input },
          summary: 'DRY RUN: would create customer. Pass dry_run=false to apply.',
        };
      }
      const customer = await createCustomer(input.project_id, { app_user_id: input.app_user_id });
      return {
        data: { executed: true, dry_run: false, customer },
        audit: { before: null, after: input },
        summary: `Customer ${input.app_user_id} created.`,
      };
    },
  }, callerHash);
}
