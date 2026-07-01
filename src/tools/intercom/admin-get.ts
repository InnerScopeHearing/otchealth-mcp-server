import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetAdmin } from '../../intercom/full-client.js';

export function registerIntercomAdminGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_admin_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom admin by ID',
      description: 'Retrieve a single admin (teammate) by their Intercom admin ID via GET /admins/:id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      admin_id: z.string().describe('Intercom admin ID.'),
    },
    outputShape: {
      admin: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const admin = await fcGetAdmin(input.admin_id);
      return {
        data: { admin },
        summary: `Admin ${input.admin_id} retrieved.`,
      };
    },
  }, callerHash);
}
