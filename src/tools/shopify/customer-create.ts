import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createCustomer } from '../../shopify/full-client.js';

export function registerShopifyCustomerCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_customer_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a Shopify customer',
      description: 'Create a new customer record via POST /customers.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      first_name: z.string().optional().describe('Customer first name.'),
      last_name: z.string().optional().describe('Customer last name.'),
      email: z.string().email().optional().describe('Customer email address.'),
      phone: z.string().optional().describe('Customer phone number in E.164 format, e.g. "+15551234567".'),
      note: z.string().optional().describe('Staff-facing note about the customer.'),
      tags: z.string().optional().describe('Comma-separated tags.'),
      verified_email: z.boolean().optional().default(true).describe('Whether the email address is verified.'),
      accepts_marketing: z.boolean().optional().describe('Whether the customer opts in to marketing.'),
      send_email_welcome: z.boolean().optional().default(false).describe('Whether to send a welcome email (default false).'),
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
          summary: `DRY RUN: would create customer "${input.first_name ?? ''} ${input.last_name ?? ''}". Pass dry_run=false to apply.`,
        };
      }
      const customer = await createCustomer(input, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, customer },
        audit: { before: null, after: input },
        summary: `Customer created.`,
      };
    },
  }, callerHash);
}
