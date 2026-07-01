import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getPrice } from '../../stripe/full-client.js';

export function registerStripePriceGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'stripe_price_get',
    category: 'read',
    annotations: {
      title: 'Get Stripe price',
      description: 'Retrieve a single price by ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      price_id: z.string().describe('Price ID (price_...).'),
    },
    outputShape: {
      id: z.string(),
      product: z.string(),
      currency: z.string(),
      unit_amount: z.number().nullable(),
      type: z.string(),
      active: z.boolean(),
      nickname: z.string().nullable(),
      recurring: z.unknown().nullable(),
    },
    handler: async (input, _ctx) => {
      const p = await getPrice(input.price_id);
      return {
        data: {
          id: p.id,
          product: typeof p.product === 'string' ? p.product : p.product?.id,
          currency: p.currency,
          unit_amount: p.unit_amount ?? null,
          type: p.type,
          active: p.active,
          nickname: p.nickname ?? null,
          recurring: p.recurring ?? null,
        },
        summary: `Price ${p.id}: ${p.currency} ${(p.unit_amount ?? 0) / 100}, type=${p.type}.`,
      };
    },
  }, callerHash);
}
