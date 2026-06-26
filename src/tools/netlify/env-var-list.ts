import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listEnvVars } from '../../netlify/full-client.js';

export function registerNetlifyEnvVarList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_env_var_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list environment variables',
      description: 'List all env vars for a Netlify account, optionally scoped to a site (GET /accounts/{account_id}/env). Returns keys and context values.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().min(1).describe('Account slug or UUID. Use netlify_accounts_list to find it.'),
      site_id: z.string().optional().describe('Scope results to a specific site ID.'),
      context_name: z.string().optional().describe('Filter by context: all, production, branch-deploy, deploy-preview, dev.'),
      scope: z.string().optional().describe('Filter by scope: builds, functions, runtime, post-processing.'),
    },
    outputShape: {
      env_vars: z.array(z.object({
        key: z.string(),
        scopes: z.array(z.string()),
        values: z.array(z.object({ id: z.string(), context: z.string(), value: z.string() })),
        is_secret: z.boolean().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const { account_id, ...opts } = input;
      const raw = await listEnvVars(account_id, opts);
      const env_vars = (raw ?? []).map((v: any) => ({
        key: v.key ?? '',
        scopes: v.scopes ?? [],
        values: (v.values ?? []).map((val: any) => ({ id: val.id ?? '', context: val.context ?? '', value: val.value ?? '' })),
        is_secret: v.is_secret ?? null,
      }));
      return {
        data: { env_vars, count: env_vars.length },
        summary: `Found ${env_vars.length} env var(s) for account ${account_id}.`,
      };
    },
  }, callerHash);
}
