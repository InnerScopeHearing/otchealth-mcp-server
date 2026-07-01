import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetCollection } from '../../intercom/full-client.js';

export function registerIntercomCollectionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_collection_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom help center collection by ID',
      description: 'Retrieve a single help center collection by its ID via GET /help_center/collections/:id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.string().describe('Intercom collection ID.'),
    },
    outputShape: {
      collection: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const collection = await fcGetCollection(input.collection_id);
      return {
        data: { collection },
        summary: `Collection ${input.collection_id} retrieved.`,
      };
    },
  }, callerHash);
}
