import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listUsers } from '../../n8n/full-client.js';

export function registerN8nUserList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_user_list',
    category: 'read',
    annotations: {
      title: 'List n8n users (admin only)',
      description:
        'List users on the n8n instance. This endpoint is only available on self-hosted n8n with owner/admin credentials. ' +
        'Returns id, email, firstName, lastName, role, and createdAt. No password or auth token data is returned.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().describe('Max results (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
      include_role: z.boolean().optional().describe('Include role information in response.'),
    },
    outputShape: {
      users: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listUsers({
        limit: input.limit,
        cursor: input.cursor,
        includeRole: input.include_role,
        correlationId: ctx.correlationId,
      });
      const users = raw?.data ?? [];
      return {
        data: { users, count: users.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${users.length} user(s).`,
      };
    },
  }, callerHash);
}
