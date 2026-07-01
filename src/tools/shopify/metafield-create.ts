import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createMetafield } from '../../shopify/full-client.js';

export function registerShopifyMetafieldCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'shopify_metafield_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a metafield',
      description: 'Create a metafield on any Shopify resource via POST /metafields.json. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      namespace: z.string().min(1).describe('Metafield namespace, e.g. "custom" or "app--12345--myapp".'),
      key: z.string().min(1).describe('Metafield key, e.g. "ingredients".'),
      value: z.string().min(1).describe('Metafield value (string; complex types should be JSON-encoded).'),
      type: z.string().min(1).describe('Metafield type, e.g. "single_line_text_field", "json", "boolean", "number_integer".'),
      owner_resource: z.enum(['product', 'variant', 'image', 'customer', 'collection', 'order', 'draft_order', 'blog', 'article', 'page', 'shop']).optional().describe('The resource type to attach to.'),
      owner_id: z.union([z.string(), z.number()]).optional().describe('The ID of the owning resource.'),
      description: z.string().optional().describe('Optional description of the metafield.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      metafield: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, metafield: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create metafield "${input.namespace}.${input.key}". Pass dry_run=false to apply.`,
        };
      }
      const metafield = await createMetafield(input as Parameters<typeof createMetafield>[0], { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, metafield },
        audit: { before: null, after: input },
        summary: `Metafield "${input.namespace}.${input.key}" created.`,
      };
    },
  }, callerHash);
}
