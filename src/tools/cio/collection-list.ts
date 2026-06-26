import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCollections } from '../../customerio/full-client.js';

export function registerCioCollectionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cio_collection_list',
    category: 'read',
    annotations: {
      title: 'List Customer.io collections',
      description: 'List all data collections in the workspace via App API GET /collections. Collections are structured datasets (e.g. product catalogs) usable in Liquid templates. Returns IDs, names, and record counts.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      collections: z.unknown(),
    },
    handler: async (_input, ctx) => {
      const collections = await listCollections({ correlationId: ctx.correlationId });
      return { data: { collections } };
    },
  }, callerHash);
}
