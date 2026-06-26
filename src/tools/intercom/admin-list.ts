import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListAdmins } from '../../intercom/full-client.js';

export function registerIntercomAdminList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_admin_list',
    category: 'read',
    annotations: {
      title: 'List Intercom admins (teammates)',
      description: 'Retrieve all admins (teammates) in the Intercom workspace via GET /admins. Returns IDs, names, emails, and away status.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      admins: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await fcListAdmins();
      const admins = resp.admins ?? resp.data ?? [];
      return {
        data: { admins, count: admins.length },
        summary: `Found ${admins.length} admin(s).`,
      };
    },
  }, callerHash);
}
