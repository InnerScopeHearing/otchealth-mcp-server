import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListCollections } from '../../intercom/full-client.js';

export function registerIntercomCollectionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_collection_list',
    category: 'read',
    annotations: {
      title: 'List Intercom help center collections',
      description: 'List all help center collections (top-level categories) in the Intercom workspace via GET /help_center/collections.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      collections: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await fcListCollections();
      const collections = resp.data ?? resp.collections ?? [];
      return {
        data: { collections, count: collections.length },
        summary: `Found ${collections.length} collection(s).`,
      };
    },
  }, callerHash);
}
