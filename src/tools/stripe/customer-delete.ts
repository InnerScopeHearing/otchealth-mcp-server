import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteCustomer } from '../../stripe/full-client.js';

export function registerStripeCustomerDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_customer_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete Stripe customer',
      description: 'Permanently delete a customer and all their payment methods. Irreversible — active subscriptions must be cancelled first. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      customer_id: z.string().describe('Customer ID (cus_...) to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      customer_id: z.string().nullable(),
      deleted: z.boolean(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, customer_id: input.customer_id, deleted: false },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete customer ${input.customer_id}. This is irreversible. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteCustomer(input.customer_id);
      return {
        data: { executed: true, dry_run: false, customer_id: upstream.id, deleted: upstream.deleted ?? true },
        audit: { before: null, after: input },
        summary: `Deleted customer ${input.customer_id}.`,
      };
    },
  }, callerHash);
}
