import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listVariants } from '../../gumroad/full-client.js';

export function registerGumroadVariantList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_variant_list',
    category: 'read',
    annotations: {
      title: 'List Gumroad variants',
      description: 'List all variants within a specific variant category of a Gumroad product.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      variant_category_id: z.string().describe('Variant category ID to list variants for.'),
    },
    outputShape: {
      variants: z.array(z.record(z.unknown())),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await listVariants(input.product_id, input.variant_category_id);
      const variants = resp.variants ?? [];
      return {
        data: { variants, count: variants.length },
        summary: `${variants.length} variant(s) in category ${input.variant_category_id}.`,
      };
    },
  }, callerHash);
}
