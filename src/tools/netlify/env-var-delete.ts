import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteEnvVar } from '../../netlify/full-client.js';

export function registerNetlifyEnvVarDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_env_var_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: delete environment variable',
      description: 'Delete an env var entirely from an account (DELETE /accounts/{account_id}/env/{key}). Irreversible. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().min(1).describe('Account slug or UUID.'),
      key: z.string().min(1).describe('Env var key to delete.'),
      site_id: z.string().optional().describe('Scope deletion to a specific site.'),
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
          summary: `DRY RUN: would DELETE env var "${input.key}" from account ${input.account_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteEnvVar(input.account_id, input.key, input.site_id ? { site_id: input.site_id } : undefined);
      return {
        data: { executed: true, dry_run: false, key: input.key },
        audit: { before: { key: input.key }, after: null },
        summary: `Deleted env var "${input.key}" from account ${input.account_id}.`,
      };
    },
  }, callerHash);
}
