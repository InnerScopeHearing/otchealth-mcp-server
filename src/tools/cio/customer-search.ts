import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { searchCustomers } from '../../customerio/full-client.js';

export function registerCioCustomerSearch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_customer_search',
    category: 'read',
    annotations: {
      title: 'Search Customer.io customers by attribute',
      description: 'Search/list customers matching a filter object via App API POST /customers. Supports attribute-based filtering. Returns matching customer IDs and attributes. Use for bulk lookups.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      filter: z.record(z.unknown()).describe('Customer.io filter expression. E.g. {"and":[{"attribute":{"field":"plan","operator":"eq","value":"pro"}}]}.'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max customers to return per page (default 100).'),
      start: z.string().optional().describe('Pagination cursor from a previous response.'),
    },
    outputShape: {
      customers: z.unknown(),
      next: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const result = await searchCustomers({
        filter: input.filter,
        limit: input.limit,
        start: input.start,
        correlationId: ctx.correlationId,
      }) as { customers?: unknown; next?: string };
      return { data: { customers: result, next: (result as Record<string, unknown>).next ?? null } };
    },
  }, callerHash);
}
