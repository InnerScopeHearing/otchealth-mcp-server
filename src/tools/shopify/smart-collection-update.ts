import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateSmartCollection } from '../../shopify/full-client.js';

const ruleSchema = z.object({
  column: z.string().describe('Product field to match, e.g. "tag", "vendor", "title".'),
  relation: z.string().describe('Comparison operator, e.g. "equals", "contains".'),
  condition: z.string().describe('Value to compare against.'),
});

export function registerShopifySmartCollectionUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_smart_collection_update',
    category: 'write_simple',
    annotations: {
      title: 'Update a smart collection',
      description: 'Update fields or rules on an existing smart collection via PUT /smart_collections/{id}.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.union([z.string(), z.number()]).describe('Shopify smart collection ID to update.'),
      title: z.string().optional().describe('New collection title.'),
      rules: z.array(ruleSchema).optional().describe('Replacement rules array (replaces all existing rules).'),
      disjunctive: z.boolean().optional().describe('OR logic for rules if true, AND logic if false.'),
      body_html: z.string().optional().describe('Collection description as HTML.'),
      sort_order: z.enum(['alpha-asc', 'alpha-desc', 'best-selling', 'created', 'created-desc', 'manual', 'price-asc', 'price-desc']).optional().describe('Default sort order.'),
      published: z.boolean().optional().describe('Whether the collection is published.'),
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
          summary: `DRY RUN: would update smart collection ${input.collection_id}. Pass dry_run=false to apply.`,
        };
      }
      const { collection_id, ...patch } = input;
      const smart_collection = await updateSmartCollection(collection_id, patch as Parameters<typeof updateSmartCollection>[1], { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, smart_collection },
        audit: { before: null, after: input },
        summary: `Smart collection ${collection_id} updated.`,
      };
    },
  }, callerHash);
}
