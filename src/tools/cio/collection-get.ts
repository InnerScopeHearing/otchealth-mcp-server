import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCollection } from '../../customerio/full-client.js';

export function registerCioCollectionGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_get',
    category: 'read',
    annotations: {
      title: 'Get a Customer.io collection',
      description: 'Fetch metadata for a single data collection via App API GET /collections/{id}. Returns the collection name, schema, and record count. Use cio_collection_get_content to fetch actual row data.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.number().int().positive().describe('Numeric ID of the collection.'),
    },
    outputShape: {
      collection: z.unknown(),
    },
    handler: async (input, ctx) => {
      const collection = await getCollection({ collection_id: input.collection_id, correlationId: ctx.correlationId });
      return { data: { collection } };
    },
  }, callerHash);
}
