import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getRedirectListItems } from '../../cloudflare/full-client.js';

export function registerCloudflareRedirectListGetItems(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_redirect_list_get_items',
    category: 'read',
    annotations: {
      title: 'Get bulk redirect list items',
      description: 'List all redirect entries in a bulk redirect list.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().describe('Cloudflare account ID.'),
      list_id: z.string().describe('Redirect list ID.'),
    },
    outputShape: {
      items: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const items = await getRedirectListItems(input.account_id, input.list_id);
      return {
        data: { items, count: items.length },
        summary: `Found ${items.length} redirect item(s) in list ${input.list_id}.`,
      };
    },
  }, callerHash);
}
