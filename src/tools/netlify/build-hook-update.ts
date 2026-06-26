import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateBuildHook } from '../../netlify/full-client.js';

export function registerNetlifyBuildHookUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_build_hook_update',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: update build hook',
      description: 'Update a build hook title or branch (PUT /sites/{site_id}/build_hooks/{id}). Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      hook_id: z.string().min(1).describe('Build hook ID to update.'),
      title: z.string().optional().describe('New title for the hook.'),
      branch: z.string().optional().describe('New branch to build when the hook is triggered.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.string().optional(),
      title: z.string().optional(),
      branch: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, id: input.hook_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update build hook ${input.hook_id}. Pass dry_run=false to apply.`,
        };
      }
      const h = await updateBuildHook(input.site_id, input.hook_id, { title: input.title, branch: input.branch });
      return {
        data: { executed: true, dry_run: false, id: h.id ?? input.hook_id, title: h.title, branch: h.branch },
        audit: { before: null, after: h },
        summary: `Updated build hook ${h.id ?? input.hook_id}.`,
      };
    },
  }, callerHash);
}
