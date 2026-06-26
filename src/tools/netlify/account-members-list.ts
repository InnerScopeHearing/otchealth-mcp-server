import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listAccountMembers } from '../../netlify/full-client.js';

export function registerNetlifyAccountMembersList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_account_members_list',
    category: 'read',
    annotations: {
      title: 'Netlify: list account members',
      description: 'List members of a Netlify team/account (GET /accounts/{account_id}/members). Returns emails, roles, and join dates.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      account_id: z.string().min(1).describe('Account ID or slug. Use netlify_accounts_list to find it.'),
    },
    outputShape: {
      members: z.array(z.object({
        id: z.string(),
        email: z.string().nullable(),
        full_name: z.string().nullable(),
        role: z.string().nullable(),
        created_at: z.string().nullable(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const raw = await listAccountMembers(input.account_id);
      const members = (raw ?? []).map((m: any) => ({
        id: m.id ?? '',
        email: m.email ?? null,
        full_name: m.full_name ?? null,
        role: m.role ?? null,
        created_at: m.created_at ?? null,
      }));
      return {
        data: { members, count: members.length },
        summary: `Found ${members.length} member(s) in account ${input.account_id}.`,
      };
    },
  }, callerHash);
}
