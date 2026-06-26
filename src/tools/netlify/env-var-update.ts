import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateEnvVar } from '../../netlify/full-client.js';

export function registerNetlifyEnvVarUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_env_var_update',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: update environment variable',
      description: 'Replace all values of an env var via PUT /accounts/{account_id}/env/{key}. Overwrites all context values. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().min(1).describe('Account slug or UUID.'),
      key: z.string().min(1).describe('Env var key to update.'),
      value: z.string().describe('New value to set.'),
      context: z.string().optional().describe('Context to set value for: all (default), production, branch-deploy, deploy-preview, dev.'),
      scopes: z.array(z.string()).optional().describe('Scopes: builds, functions, runtime, post-processing. Defaults to all four.'),
      site_id: z.string().optional().describe('Scope the update to a specific site.'),
      is_secret: z.boolean().optional().describe('Mark as secret (value masked in UI).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      key: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, key: input.key },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update env var "${input.key}" on account ${input.account_id}. Pass dry_run=false to apply.`,
        };
      }
      const context = input.context ?? 'all';
      const scopes = input.scopes ?? ['builds', 'functions', 'runtime', 'post-processing'];
      const updated = await updateEnvVar(input.account_id, input.key, {
        scopes,
        values: [{ context, value: input.value }],
        is_secret: input.is_secret,
        site_id: input.site_id,
      });
      return {
        data: { executed: true, dry_run: false, key: updated.key ?? input.key },
        audit: { before: null, after: updated },
        summary: `Updated env var "${updated.key ?? input.key}" (context: ${context}).`,
      };
    },
  }, callerHash);
}
