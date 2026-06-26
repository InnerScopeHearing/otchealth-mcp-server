import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listUsers } from '../../graph/full-client.js';

export function registerGraphUserList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_user_list',
    category: 'read',
    annotations: {
      title: 'List Azure AD users (basic profile)',
      description: 'List users in the Azure AD tenant via GET /users with basic profile fields only (id, displayName, mail, UPN, jobTitle, department, officeLocation). No PHI, no admin data, no group membership. Requires User.Read.All application permission. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      top: z.number().int().min(1).max(100).optional().describe('Number of users to return (max 100, default 25).'),
      filter: z.string().optional().describe('OData $filter expression, e.g. "department eq \'Engineering\'".'),
    },
    outputShape: {
      users: z.array(z.object({
        id: z.string(),
        display_name: z.string(),
        mail: z.string(),
        user_principal_name: z.string(),
        job_title: z.string(),
        department: z.string(),
        office_location: z.string(),
      })),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const users = await listUsers({ top: input.top ?? 25, filter: input.filter });
      const mapped = users.map((u: any) => ({
        id: u.id ?? '',
        display_name: u.displayName ?? '',
        mail: u.mail ?? '',
        user_principal_name: u.userPrincipalName ?? '',
        job_title: u.jobTitle ?? '',
        department: u.department ?? '',
        office_location: u.officeLocation ?? '',
      }));
      return {
        data: { users: mapped, count: mapped.length },
        summary: `Found ${mapped.length} user(s).`,
      };
    },
  }, callerHash);
}
