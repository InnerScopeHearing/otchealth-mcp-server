import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listAccounts } from '../../netlify/full-client.js';

export function registerNetlifyAccountsList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_accounts_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list accounts / teams',
      description: 'List all Netlify accounts (teams) accessible with this token (GET /accounts). Returns slugs and IDs needed for env-var and DNS operations.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      accounts: z.array(z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        type: z.string().nullable(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const raw = await listAccounts();
      const accounts = (raw ?? []).map((a: any) => ({
        id: a.id ?? '',
        slug: a.slug ?? '',
        name: a.name ?? '',
        type: a.type ?? null,
        created_at: a.created_at ?? null,
      }));
      return {
        data: { accounts, count: accounts.length },
        summary: `Found ${accounts.length} account(s)/team(s).`,
      };
    },
  }, callerHash);
}
