import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListSegments } from '../../intercom/full-client.js';

export function registerIntercomSegmentList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_segment_list',
    category: 'read',
    annotations: {
      title: 'List Intercom segments',
      description: 'Retrieve all contact segments (saved filters/audiences) in the Intercom workspace via GET /segments.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      segments: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await fcListSegments();
      const segments = resp.segments ?? resp.data ?? [];
      return {
        data: { segments, count: segments.length },
        summary: `Found ${segments.length} segment(s).`,
      };
    },
  }, callerHash);
}
