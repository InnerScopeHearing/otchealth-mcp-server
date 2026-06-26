import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSmartCollection } from '../../shopify/full-client.js';

const ruleSchema = z.object({
  column: z.enum(['title', 'type', 'vendor', 'variant_price', 'tag', 'variant_compare_at_price', 'variant_weight', 'variant_inventory', 'variant_title']).describe('The product field to apply the rule to.'),
  relation: z.enum(['equals', 'not_equals', 'greater_than', 'less_than', 'starts_with', 'ends_with', 'contains', 'not_contains']).describe('The comparison operator.'),
  condition: z.string().describe('The value to compare against.'),
});

export function registerShopifySmartCollectionCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_smart_collection_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a smart collection',
      description: 'Create a rule-based (automated) product collection via POST /smart_collections.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      title: z.string().min(1).describe('Collection title (required).'),
      rules: z.array(ruleSchema).optional().describe('Automation rules. Products matching all rules (or any if disjunctive=true) are included.'),
      disjunctive: z.boolean().optional().default(false).describe('If true, products matching ANY rule are included (OR logic). Default false = AND logic.'),
      body_html: z.string().optional().describe('Collection description as HTML.'),
      sort_order: z.enum(['alpha-asc', 'alpha-desc', 'best-selling', 'created', 'created-desc', 'manual', 'price-asc', 'price-desc']).optional().describe('Default sort order.'),
      published: z.boolean().optional().default(false).describe('Whether to publish immediately.'),
      handle: z.string().optional().describe('URL handle (slug).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      smart_collection: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, smart_collection: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create smart collection "${input.title}" with ${input.rules?.length ?? 0} rules. Pass dry_run=false to apply.`,
        };
      }
      const smart_collection = await createSmartCollection(input as Parameters<typeof createSmartCollection>[0], { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, smart_collection },
        audit: { before: null, after: input },
        summary: `Smart collection "${input.title}" created.`,
      };
    },
  }, callerHash);
}
