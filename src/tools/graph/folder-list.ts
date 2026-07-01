import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listMailFolders } from '../../graph/full-client.js';

export function registerGraphFolderList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_folder_list',
    category: 'read',
    annotations: {
      title: 'List mail folders',
      description: 'List all mail folders in the COO mailbox via GET /users/{sender}/mailFolders. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      include_hidden: z.boolean().optional().describe('If true, include hidden system folders.'),
    },
    outputShape: {
      folders: z.array(z.object({
        id: z.string(),
        display_name: z.string(),
        total_item_count: z.number(),
        unread_item_count: z.number(),
        child_folder_count: z.number(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const folders = await listMailFolders(input.include_hidden);
      const mapped = folders.map((f: any) => ({
        id: f.id ?? '',
        display_name: f.displayName ?? '',
        total_item_count: f.totalItemCount ?? 0,
        unread_item_count: f.unreadItemCount ?? 0,
        child_folder_count: f.childFolderCount ?? 0,
      }));
      return {
        data: { folders: mapped, count: mapped.length },
        summary: `Found ${mapped.length} mail folder(s).`,
      };
    },
  }, callerHash);
}
