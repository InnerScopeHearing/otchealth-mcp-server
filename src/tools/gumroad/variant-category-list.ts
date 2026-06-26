import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listVariantCategories } from '../../gumroad/full-client.js';

export function registerGumroadVariantCategoryList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_category_list',
    category: 'read',
    annotations: {
      title: 'List Gumroad variant categories',
      description: 'List all variant categories (e.g. "Size", "Color") for a given Gumroad product.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
    },
    outputShape: {
      variant_categories: z.array(z.record(z.unknown())),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await listVariantCategories(input.product_id);
      const cats = resp.variant_categories ?? [];
      return {
        data: { variant_categories: cats, count: cats.length },
        summary: `${cats.length} variant category/categories for product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
