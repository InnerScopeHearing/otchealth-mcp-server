import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listOrgMembers } from '../../sentry/full-client.js';

export function registerSentryMemberList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'sentry_member_list',
    category: 'read',
    annotations: {
      title: 'List Sentry org members',
      description: 'List all members of the Sentry organization.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {},
    outputShape: { members: z.array(z.unknown()), count: z.number() },
    handler: async () => {
      const members = await listOrgMembers();
      return { data: { members, count: members.length }, summary: `${members.length} org member(s).` };
    },
  }, callerHash);
}
