import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { expireCheckoutSession } from '../../stripe/full-client.js';

export function registerStripeCheckoutSessionExpire(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_checkout_session_expire',
    category: 'write_simple',
    annotations: {
      title: 'Expire Stripe checkout session',
      description: 'Expire an open checkout session, preventing further access. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      session_id: z.string().describe('Checkout session ID (cs_...) to expire.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      session_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, session_id: input.session_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would expire checkout session ${input.session_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await expireCheckoutSession(input.session_id);
      return {
        data: { executed: true, dry_run: false, session_id: upstream.id, status: upstream.status ?? null },
        audit: { before: null, after: input },
        summary: `Expired checkout session ${upstream.id}.`,
      };
    },
  }, callerHash);
}
