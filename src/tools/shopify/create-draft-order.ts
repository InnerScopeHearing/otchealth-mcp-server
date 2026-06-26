import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDraftOrder } from '../../shopify/write-client.js';

const addressSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  country: z.string().optional().describe('Two-letter ISO country code, e.g. "US".'),
  zip: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
});

const lineItemSchema = z.object({
  variant_id: z.number().int().positive().optional().describe('Shopify variant ID.'),
  title: z
    .string()
    .optional()
    .describe('Required for custom (non-catalogue) line items.'),
  price: z
    .string()
    .optional()
    .describe('Override price for custom items, e.g. "19.99".'),
  quantity: z.number().int().positive().describe('Quantity (required).'),
  sku: z.string().optional(),
  custom: z
    .boolean()
    .optional()
    .describe('Set true for custom (one-off) line items that have no variant_id.'),
  requires_shipping: z.boolean().optional(),
  taxable: z.boolean().optional().default(true),
  properties: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional()
    .describe('Key-value metadata displayed on packing slips.'),
  applied_discount: z
    .object({
      value_type: z.enum(['fixed_amount', 'percentage']),
      value: z.string().describe('Discount amount, e.g. "5.00" or "10" (percent).'),
      description: z.string().optional(),
      title: z.string().optional(),
    })
    .optional()
    .describe('Per-line-item discount.'),
});

export function registerShopifyCreateDraftOrder(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'shopify_create_draft_order',
      category: 'write_simple',
      annotations: {
        title: 'Create a Shopify draft order',
        description:
          'Create a draft order via POST /draft_orders.json. Draft orders are staging orders: they ' +
          'can be reviewed, edited, invoiced, and then completed (which creates a real order). ' +
          'Use shopify_complete_draft_order to convert. Defaults to dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        line_items: z
          .array(lineItemSchema)
          .min(1)
          .describe('Line items (required, at least one).'),
        customer_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Shopify customer ID to associate the draft order with.'),
        customer_email: z
          .string()
          .email()
          .optional()
          .describe('Customer email (used when customer_id is not provided).'),
        email: z
          .string()
          .email()
          .optional()
          .describe('Contact email for the draft order itself (invoice recipient).'),
        note: z.string().optional().describe('Internal staff note.'),
        tags: z.string().optional().describe('Comma-separated tags.'),
        use_customer_default_address: z
          .boolean()
          .optional()
          .describe('If true, use the customer\'s default address.'),
        shipping_address: addressSchema.optional(),
        billing_address: addressSchema.optional(),
        shipping_line: z
          .object({
            title: z.string().describe('Shipping method label, e.g. "Standard Shipping".'),
            price: z.string().describe('Shipping cost, e.g. "0.00".'),
            custom: z.boolean().default(true),
            code: z.string().optional(),
          })
          .optional()
          .describe('Custom shipping line. Omit to let Shopify calculate.'),
        applied_discount: z
          .object({
            value_type: z.enum(['fixed_amount', 'percentage']),
            value: z
              .string()
              .describe('Discount amount as string, e.g. "10.00" or "15" (percent).'),
            description: z.string().optional(),
            title: z.string().optional(),
          })
          .optional()
          .describe('Order-level discount.'),
        tax_exempt: z.boolean().optional().describe('Override tax calculation.'),
        send_receipt: z
          .boolean()
          .optional()
          .describe('Send a Shopify draft-order invoice email immediately on creation.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        draft_order: z.unknown().nullable(),
      },
      handler: async (input, ctx) => {
        const { customer_id, customer_email, ...rest } = input;

        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, draft_order: null },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create draft order with ${input.line_items.length} line item(s). Pass dry_run=false to apply.`,
          };
        }

        const draftOrder = await createDraftOrder(
          {
            line_items: rest.line_items as never,
            customer:
              customer_id !== undefined
                ? { id: customer_id }
                : customer_email !== undefined
                  ? { email: customer_email }
                  : undefined,
            email: rest.email,
            note: rest.note,
            tags: rest.tags,
            use_customer_default_address: rest.use_customer_default_address,
            shipping_address: rest.shipping_address,
            billing_address: rest.billing_address,
            shipping_line: rest.shipping_line,
            applied_discount: rest.applied_discount as never,
            tax_exempt: rest.tax_exempt,
            send_receipt: rest.send_receipt,
          },
          { correlationId: ctx.correlationId },
        );

        return {
          data: { executed: true, dry_run: false, draft_order: draftOrder },
          audit: { before: null, after: input },
          summary: `Draft order created.`,
        };
      },
    },
    callerHash,
  );
}
