import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { captureCharge } from '../../stripe/full-client.js';

export function registerStripeChargeCapture(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_charge_capture',
    category: 'write_orchestrated',
    annotations: {
      title: 'Capture Stripe charge',
      description: 'Capture an uncaptured (authorized) charge. Money movement. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      charge_id: z.string().describe('Charge ID (ch_...) to capture.'),
      amount: z.number().int().min(1).optional().describe('Amount to capture in cents. Defaults to full auth amount.'),
      receipt_email: z.string().email().optional().describe('Email to send receipt to.'),
      statement_descriptor: z.string().max(22).optional().describe('Statement descriptor override.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      charge_id: z.string().nullable(),
      status: z.string().nullable(),
      amount_captured: z.number().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, charge_id: input.charge_id, status: null, amount_captured: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would capture charge ${input.charge_id}. Pass dry_run=false to apply.`,
        };
      }
      const { charge_id, ...params } = input;
      const upstream = await captureCharge(charge_id, params);
      return {
        data: { executed: true, dry_run: false, charge_id: upstream.id, status: upstream.status, amount_captured: upstream.amount_captured ?? null },
        audit: { before: null, after: input },
        summary: `Captured charge ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
