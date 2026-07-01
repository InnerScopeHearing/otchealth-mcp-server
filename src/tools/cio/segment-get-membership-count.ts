import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getSegmentMembershipCount } from '../../customerio/full-client.js';

export function registerCioSegmentGetMembershipCount(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_segment_get_membership_count',
    category: 'read',
    annotations: {
      title: 'Get Customer.io segment membership count',
      description: 'Fetch the current number of customers in a segment via App API GET /segments/{id}/customer_count. Returns the total member count and last-updated timestamp.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      segment_id: z.number().int().positive().describe('Numeric ID of the segment to count members for.'),
    },
    outputShape: {
      count_info: z.unknown(),
    },
    handler: async (input, ctx) => {
      const count_info = await getSegmentMembershipCount({ segment_id: input.segment_id, correlationId: ctx.correlationId });
      return { data: { count_info } };
    },
  }, callerHash);
}
