import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getEnvVar } from '../../netlify/full-client.js';

export function registerNetlifyEnvVarGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_env_var_get',
    category: 'read',
    annotations: {
      title: 'Netlify: get environment variable by key',
      description: 'Fetch a single env var by key from a Netlify account (GET /accounts/{account_id}/env/{key}). Optionally scope to a site.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().min(1).describe('Account slug or UUID.'),
      key: z.string().min(1).describe('Env var key name (e.g. "API_URL").'),
      site_id: z.string().optional().describe('Scope to a specific site ID.'),
    },
    outputShape: {
      key: z.string(),
      scopes: z.array(z.string()),
      values: z.array(z.object({ id: z.string(), context: z.string(), value: z.string() })),
      is_secret: z.boolean().nullable(),
    },
    handler: async (input, _ctx) => {
      const v = await getEnvVar(input.account_id, input.key, input.site_id ? { site_id: input.site_id } : undefined);
      return {
        data: {
          key: v.key ?? input.key,
          scopes: v.scopes ?? [],
          values: (v.values ?? []).map((val: any) => ({ id: val.id ?? '', context: val.context ?? '', value: val.value ?? '' })),
          is_secret: v.is_secret ?? null,
        },
        summary: `Env var "${v.key ?? input.key}" has ${(v.values ?? []).length} context value(s).`,
      };
    },
  }, callerHash);
}
