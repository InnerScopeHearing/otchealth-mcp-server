import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listBroadcasts } from '../../customerio/full-client.js';

export function registerCioBroadcastList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_broadcast_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io broadcasts',
      description: 'List all newsletter/broadcast sends in the workspace via App API GET /newsletters. Returns ID, name, type, state, and schedule info for each broadcast.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max broadcasts to return (default 50).'),
      start_after: z.number().int().optional().describe('Pagination cursor — last broadcast ID from previous page.'),
    },
    outputShape: {
      broadcasts: z.unknown(),
    },
    handler: async (input, ctx) => {
      const result = await listBroadcasts({ limit: input.limit, start_after: input.start_after, correlationId: ctx.correlationId });
      return { data: { broadcasts: result } };
    },
  }, callerHash);
}
