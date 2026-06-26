import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createMailFolder } from '../../graph/full-client.js';

export function registerGraphFolderCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_folder_create',
    category: 'write_simple',
    annotations: {
      title: 'Create a mail folder',
      description: 'Create a new mail folder in the COO mailbox via POST /users/{sender}/mailFolders. Optionally nest under a parent folder. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      display_name: z.string().describe('Display name for the new folder.'),
      parent_folder_id: z.string().optional().describe('ID of the parent folder (omit to create at root level).'),
      is_hidden: z.boolean().optional().describe('Whether to create the folder as hidden.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      folder_id: z.string().nullable(),
      display_name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, folder_id: null, display_name: input.display_name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create mail folder "${input.display_name}". Pass dry_run=false to apply.`,
        };
      }
      const folder = await createMailFolder({
        displayName: input.display_name,
        parentFolderId: input.parent_folder_id,
        isHidden: input.is_hidden,
      });
      return {
        data: { executed: true, dry_run: false, folder_id: folder.id ?? null, display_name: folder.displayName ?? input.display_name },
        audit: { before: null, after: input },
        summary: `Mail folder "${folder.displayName}" created (id: ${folder.id}).`,
      };
    },
  }, callerHash);
}
