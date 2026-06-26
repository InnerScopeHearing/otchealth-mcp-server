import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getTransactionalMessage } from '../../customerio/full-client.js';

export function registerCioTransactionalGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_transactional_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io transactional message template',
      description: 'Fetch full details of a transactional message template via App API GET /transactional/{id}. Returns name, subject, body, from address, and available Liquid variables.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      transactional_message_id: z.union([z.number().int().positive(), z.string().min(1)]).describe('Numeric or string ID of the transactional message template.'),
    },
    outputShape: {
      transactional_message: z.unknown(),
    },
    handler: async (input, ctx) => {
      const transactional_message = await getTransactionalMessage({
        transactional_message_id: input.transactional_message_id,
        correlationId: ctx.correlationId,
      });
      return { data: { transactional_message } };
    },
  }, callerHash);
}
