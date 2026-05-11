import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet, CustomerIoApiError } from '../../customerio/app-api-client.js';

export function registerGetSegment(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'cio_get_segment',
      category: 'read',
      annotations: {
        title: 'Get a Customer.io segment',
        description:
          'Fetch segment metadata: name, type, description, rules if exposed, and size when available. Workspace 193366 currently has ~16 segments.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        segment_id: z
          .union([z.string(), z.number()])
          .describe('Customer.io segment ID.'),
        include_count: z
          .boolean()
          .optional()
          .describe('If true, also fetch the segment customer count via /segments/{id}/customer_count.'),
      },
      outputShape: {
        segment: z.unknown(),
        customer_count: z.number().nullable(),
        customer_count_status: z.string(),
      },
      handler: async (input, ctx) => {
        const id = encodeURIComponent(String(input.segment_id));
        const segment = await appApiGet<unknown>(`/segments/${id}`, {
          correlationId: ctx.correlationId,
        });

        let customer_count: number | null = null;
        let customer_count_status = 'not_requested';
        if (input.include_count === true) {
          try {
            const c = await appApiGet<{ count?: number }>(`/segments/${id}/customer_count`, {
              correlationId: ctx.correlationId,
            });
            customer_count = typeof c.count === 'number' ? c.count : null;
            customer_count_status = customer_count !== null ? 'ok' : 'unknown_shape';
          } catch (err) {
            if (err instanceof CustomerIoApiError && err.status === 404) {
              customer_count_status = 'unsupported_via_api';
            } else {
              throw err;
            }
          }
        }
        return {
          data: { segment, customer_count, customer_count_status },
        };
      },
    },
    callerHash,
  );
}
