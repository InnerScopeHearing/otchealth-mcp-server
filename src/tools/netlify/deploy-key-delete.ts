import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteDeployKey } from '../../netlify/full-client.js';

export function registerNetlifyDeployKeyDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_key_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete deploy key',
      description: 'Delete a deploy key (DELETE /deploy_keys/{key_id}). Breaks repo linking if the key is in use. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      key_id: z.string().min(1).describe('Deploy key ID to delete. Use netlify_deploy_key_list to find it.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      key_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, key_id: input.key_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete deploy key ${input.key_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteDeployKey(input.key_id);
      return {
        data: { executed: true, dry_run: false, key_id: input.key_id },
        audit: { before: { key_id: input.key_id }, after: null },
        summary: `Deleted deploy key ${input.key_id}.`,
      };
    },
  }, callerHash);
}
