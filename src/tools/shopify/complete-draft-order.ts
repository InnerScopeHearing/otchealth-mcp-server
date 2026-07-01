import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { completeDraftOrder } from '../../shopify/write-client.js';

export function registerShopifyCompleteDraftOrder(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_complete_draft_order',
      category: 'write_orchestrated', // converts to real order; may trigger payment capture
      annotations: {
        title: 'Complete a Shopify draft order (creates real order)',
        description:
          'Convert a draft order to a real order via PUT /draft_orders/{id}/complete.json. ' +
          'This is IRREVERSIBLE: the resulting order may trigger payment capture and fulfilment. ' +
          'Always review the draft order via shopify_get_order or Admin UI before completing. ' +
          'Requires ENABLE_HIGH_RISK_TOOLS=true. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        draft_order_id: z
          .union([z.string(), z.number()])
          .describe(
            'Draft order ID to complete. Obtain from shopify_create_draft_order output or Admin UI.',
          ),
        payment_pending: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If false (default), Shopify marks payment as paid immediately (manual payment assumed). ' +
              'If true, order is created with payment_status=pending for later capture.',
          ),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        draft_order: z.unknown().nullable(),
        resulting_order_id: z.number().nullable(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              draft_order: null,
              resulting_order_id: null,
            },
            audit: { before: null, after: input },
            summary:
              `DRY RUN: would complete draft order ${input.draft_order_id} ` +
              `(payment_pending=${input.payment_pending ?? false}), creating a REAL order. Pass dry_run=false to apply.`,
          };
        }

        const result = await completeDraftOrder(
          input.draft_order_id,
          input.payment_pending ?? false,
          { correlationId: ctx.correlationId },
        );

        const draftOrder = result as { order_id?: number } | null;
        const resulting_order_id = draftOrder?.order_id ?? null;

        return {
          data: {
            executed: true,
            dry_run: false,
            draft_order: result,
            resulting_order_id,
          },
          audit: { before: null, after: input },
          summary: `Draft order ${input.draft_order_id} completed.` +
            (resulting_order_id ? ` Real order ID: ${resulting_order_id}.` : ''),
        };
      },
    },
    callerHash,
  );
}
