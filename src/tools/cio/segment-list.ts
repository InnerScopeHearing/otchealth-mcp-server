import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listSegments } from '../../customerio/full-client.js';

export function registerCioSegmentList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_segment_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io segments',
      description: 'List all segments in the Customer.io workspace via App API GET /segments. Returns segment IDs, names, types (manual/behavioral/data), and customer counts.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max segments to return (default 50).'),
      start_after: z.number().int().optional().describe('Pagination cursor — last segment ID from previous page.'),
    },
    outputShape: {
      segments: z.unknown(),
    },
    handler: async (input, ctx) => {
      const result = await listSegments({ limit: input.limit, start_after: input.start_after, correlationId: ctx.correlationId });
      return { data: { segments: result } };
    },
  }, callerHash);
}
