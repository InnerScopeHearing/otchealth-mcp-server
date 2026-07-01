import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getOfferCode } from '../../gumroad/full-client.js';

export function registerGumroadOfferCodeGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_offer_code_get',
    category: 'read',
    annotations: {
      title: 'Get single Gumroad offer code',
      description: 'Retrieve details for a specific offer code on a Gumroad product.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
      offer_code_id: z.string().describe('Offer code ID.'),
    },
    outputShape: {
      offer_code: z.record(z.unknown()),
    },
    handler: async (input, _ctx) => {
      const resp = await getOfferCode(input.product_id, input.offer_code_id);
      const code = resp.offer_code ?? resp;
      return {
        data: { offer_code: code },
        summary: `Offer code "${code.name ?? input.offer_code_id}": ${code.amount_off} ${code.offer_type ?? ''} off.`,
      };
    },
  }, callerHash);
}
