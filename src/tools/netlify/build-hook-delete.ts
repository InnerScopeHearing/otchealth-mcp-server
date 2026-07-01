import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteBuildHook } from '../../netlify/full-client.js';

export function registerNetlifyBuildHookDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_build_hook_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete build hook',
      description: 'Delete a build hook permanently (DELETE /sites/{site_id}/build_hooks/{id}). Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      hook_id: z.string().min(1).describe('Build hook ID to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      hook_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, hook_id: input.hook_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete build hook ${input.hook_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteBuildHook(input.site_id, input.hook_id);
      return {
        data: { executed: true, dry_run: false, hook_id: input.hook_id },
        audit: { before: { hook_id: input.hook_id }, after: null },
        summary: `Deleted build hook ${input.hook_id} from site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
