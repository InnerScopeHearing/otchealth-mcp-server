import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getOrgMember } from '../../sentry/full-client.js';

export function registerSentryMemberGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_member_get',
    category: 'read',
    annotations: {
      title: 'Get a Sentry org member',
      description: 'Retrieve details for a single Sentry organization member by member ID.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      member_id: z.string().min(1).describe('Sentry organization member ID.'),
    },
    outputShape: { member: z.unknown() },
    handler: async (input) => {
      const member = await getOrgMember(input.member_id);
      return { data: { member }, summary: `Member ${input.member_id} retrieved.` };
    },
  }, callerHash);
}
