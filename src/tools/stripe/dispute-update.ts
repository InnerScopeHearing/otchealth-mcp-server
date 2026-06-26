import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateDispute } from '../../stripe/full-client.js';

export function registerStripeDisputeUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_dispute_update',
    category: 'write_simple',
    annotations: {
      title: 'Update Stripe dispute evidence',
      description: 'Submit or update evidence for a dispute. Set submit=true to send to issuer. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      dispute_id: z.string().describe('Dispute ID (dp_...) to update.'),
      submit: z.boolean().optional().describe('If true, submit evidence to the card issuer immediately.'),
      customer_email_address: z.string().email().optional().describe('Customer email for evidence.'),
      customer_name: z.string().optional().describe('Customer name for evidence.'),
      customer_purchase_ip: z.string().optional().describe('Customer IP at time of purchase.'),
      product_description: z.string().optional().describe('Description of product/service.'),
      receipt: z.string().optional().describe('Receipt file ID (uploaded to Stripe).'),
      refund_policy: z.string().optional().describe('Refund policy file ID.'),
      uncategorized_text: z.string().optional().describe('Additional notes for the issuer.'),
      metadata: z.record(z.string()).optional().describe('Key-value metadata.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      dispute_id: z.string().nullable(),
      status: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, dispute_id: input.dispute_id, status: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update dispute ${input.dispute_id}. Pass dry_run=false to apply.`,
        };
      }
      const { dispute_id, submit, metadata, ...evidenceFields } = input;
      const evidence: Record<string, string> = {};
      for (const [k, v] of Object.entries(evidenceFields)) {
        if (v !== undefined) evidence[k] = String(v);
      }
      const upstream = await updateDispute(dispute_id, {
        evidence: Object.keys(evidence).length ? evidence : undefined,
        metadata,
        submit,
      });
      return {
        data: { executed: true, dry_run: false, dispute_id: upstream.id, status: upstream.status },
        audit: { before: null, after: input },
        summary: `Updated dispute ${upstream.id} (${upstream.status}).`,
      };
    },
  }, callerHash);
}
