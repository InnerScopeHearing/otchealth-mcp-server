import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getUser } from '../../n8n/full-client.js';

export function registerN8nUserGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_user_get',
    category: 'read',
    annotations: {
      title: 'Get n8n user (admin only)',
      description:
        'Retrieve a single n8n user by their UUID or email address. Only available on self-hosted n8n with owner/admin credentials. ' +
        'Returns profile and role info. No password or sensitive auth data is returned.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      user_id: z.string().min(1).describe('User UUID or email address.'),
      include_role: z.boolean().optional().describe('Include role in response.'),
    },
    outputShape: {
      user: z.unknown(),
    },
    handler: async (input, ctx) => {
      const user = await getUser(input.user_id, {
        includeRole: input.include_role,
        correlationId: ctx.correlationId,
      });
      return {
        data: { user },
        summary: `Retrieved user ${input.user_id}.`,
      };
    },
  }, callerHash);
}
