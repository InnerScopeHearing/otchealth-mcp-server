import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetSegment } from '../../intercom/full-client.js';

export function registerIntercomSegmentGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_segment_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom segment by ID',
      description: 'Retrieve a single segment by its ID via GET /segments/:id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      segment_id: z.string().describe('Intercom segment ID.'),
    },
    outputShape: {
      segment: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const segment = await fcGetSegment(input.segment_id);
      return {
        data: { segment },
        summary: `Segment ${input.segment_id} retrieved.`,
      };
    },
  }, callerHash);
}
