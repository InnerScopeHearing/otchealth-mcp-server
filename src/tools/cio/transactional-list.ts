import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTransactionalMessages } from '../../customerio/full-client.js';

export function registerCioTransactionalList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_transactional_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io transactional message templates',
      description: 'List all transactional message templates in the workspace via App API GET /transactional. Returns template IDs, names, and state — useful for finding the right transactional_message_id before calling cio_send_transactional.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(100).optional().describe('Max templates to return (default 50).'),
      start_after: z.number().int().optional().describe('Pagination cursor — last template ID from previous page.'),
    },
    outputShape: {
      transactional_messages: z.unknown(),
    },
    handler: async (input, ctx) => {
      const transactional_messages = await listTransactionalMessages({
        limit: input.limit,
        start_after: input.start_after,
        correlationId: ctx.correlationId,
      });
      return { data: { transactional_messages } };
    },
  }, callerHash);
}
