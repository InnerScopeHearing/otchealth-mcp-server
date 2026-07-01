import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getUser } from '../../graph/full-client.js';

export function registerGraphUserGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'graph_user_get',
    category: 'read',
    annotations: {
      title: 'Get a user profile (basic)',
      description: 'Retrieve basic profile information for an Azure AD user by ID or UPN via GET /users/{userId}. Returns display name, email, job title, department, and phones. No PHI or directory-admin data. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      user_id: z.string().describe('Azure AD user ID (GUID) or user principal name (UPN) e.g. "john@contoso.com". Use "me" for the sender account.'),
    },
    outputShape: {
      id: z.string(),
      display_name: z.string(),
      given_name: z.string(),
      surname: z.string(),
      mail: z.string(),
      user_principal_name: z.string(),
      job_title: z.string(),
      department: z.string(),
      office_location: z.string(),
      business_phones: z.array(z.string()),
      mobile_phone: z.string(),
    },
    handler: async (input, _ctx) => {
      const u = await getUser(input.user_id);
      return {
        data: {
          id: u.id ?? '',
          display_name: u.displayName ?? '',
          given_name: u.givenName ?? '',
          surname: u.surname ?? '',
          mail: u.mail ?? '',
          user_principal_name: u.userPrincipalName ?? '',
          job_title: u.jobTitle ?? '',
          department: u.department ?? '',
          office_location: u.officeLocation ?? '',
          business_phones: u.businessPhones ?? [],
          mobile_phone: u.mobilePhone ?? '',
        },
        summary: `Retrieved user "${u.displayName}" (${u.mail ?? u.userPrincipalName}).`,
      };
    },
  }, callerHash);
}
