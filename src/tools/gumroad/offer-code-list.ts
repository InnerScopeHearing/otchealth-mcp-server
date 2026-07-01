import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listOfferCodes } from '../../gumroad/full-client.js';

export function registerGumroadOfferCodeList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_offer_code_list',
    category: 'read',
    annotations: {
      title: 'List Gumroad offer codes',
      description: 'List all offer codes (discount codes) for a Gumroad product.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
    },
    outputShape: {
      offer_codes: z.array(z.record(z.unknown())),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await listOfferCodes(input.product_id);
      const codes = resp.offer_codes ?? [];
      return {
        data: { offer_codes: codes, count: codes.length },
        summary: `${codes.length} offer code(s) for product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
