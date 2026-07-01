import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getCollectionContent } from '../../customerio/full-client.js';

export function registerCioCollectionGetContent(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_get_content',
    category: 'read',
    annotations: {
      title: 'Get Customer.io collection row data',
      description: 'Fetch the actual row data stored in a collection via App API GET /collections/{id}/content. Returns all records in the collection dataset.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      collection_id: z.number().int().positive().describe('Numeric ID of the collection to fetch content for.'),
    },
    outputShape: {
      content: z.unknown(),
    },
    handler: async (input, ctx) => {
      const content = await getCollectionContent({ collection_id: input.collection_id, correlationId: ctx.correlationId });
      return { data: { content } };
    },
  }, callerHash);
}
