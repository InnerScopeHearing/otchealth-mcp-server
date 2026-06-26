import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateCustomer } from '../../shopify/full-client.js';

export function registerShopifyCustomerUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_customer_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a Shopify customer',
      description: 'Update an existing customer record via PUT /customers/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      customer_id: z.union([z.string(), z.number()]).describe('Shopify customer ID to update.'),
      first_name: z.string().optional().describe('Customer first name.'),
      last_name: z.string().optional().describe('Customer last name.'),
      email: z.string().email().optional().describe('Customer email address.'),
      phone: z.string().optional().describe('Customer phone number.'),
      note: z.string().optional().describe('Staff-facing note.'),
      tags: z.string().optional().describe('Comma-separated tags (replaces existing).'),
      accepts_marketing: z.boolean().optional().describe('Whether the customer opts in to marketing.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      customer: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, customer: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update customer ${input.customer_id}. Pass dry_run=false to apply.`,
        };
      }
      const { customer_id, ...patch } = input;
      const customer = await updateCustomer(customer_id, patch, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, customer },
        audit: { before: null, after: input },
        summary: `Customer ${customer_id} updated.`,
      };
    },
  }, callerHash);
}
