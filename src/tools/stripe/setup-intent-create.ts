import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSetupIntent } from '../../stripe/full-client.js';

export function registerStripeSetupIntentCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_setup_intent_create',
    category: 'write_simple',
    annotations: {
      title: 'Create Stripe setup intent',
      description: 'Create a setup intent to securely save a payment method for future use. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      customer: z.string().optional().describe('Customer ID to attach the payment method to.'),
      payment_method: z.string().optional().describe('Payment method ID (pm_...) to set up.'),
      payment_method_types: z.array(z.string()).optional().describe('Allowed payment method types (e.g. ["card"]).'),
      usage: z.enum(['off_session', 'on_session']).optional().describe('Intended usage (default off_session).'),
      description: z.string().optional().describe('Internal description.'),
      confirm: z.boolean().optional().describe('Confirm immediately if true.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      setup_intent_id: z.string().nullable(),
      status: z.string().nullable(),
      client_secret: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, setup_intent_id: null, status: null, client_secret: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create setup intent for customer ${input.customer ?? '(none)'}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await createSetupIntent({
        customer: input.customer,
        payment_method: input.payment_method,
        payment_method_types: input.payment_method_types,
        usage: input.usage,
        description: input.description,
        confirm: input.confirm,
        metadata: input.metadata,
      });
      return {
        data: { executed: true, dry_run: false, setup_intent_id: upstream.id, status: upstream.status, client_secret: upstream.client_secret ?? null },
        audit: { before: null, after: input },
        summary: `Created setup intent ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
