import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listRedirectLists } from '../../cloudflare/full-client.js';

export function registerCloudflareRedirectListList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'cloudflare_redirect_list_list',
    category: 'read',
    annotations: {
      title: 'List bulk redirect lists',
      description: 'List all bulk redirect lists for an account.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().describe('Cloudflare account ID.'),
    },
    outputShape: {
      lists: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const lists = await listRedirectLists(input.account_id);
      return {
        data: { lists, count: lists.length },
        summary: `Found ${lists.length} redirect list(s).`,
      };
    },
  }, callerHash);
}
