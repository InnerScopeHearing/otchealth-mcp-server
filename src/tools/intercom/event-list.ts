import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListEvents } from '../../intercom/full-client.js';

export function registerIntercomEventList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_event_list',
    category: 'read',
    annotations: {
      title: 'List events for an Intercom contact',
      description: 'Retrieve data events for a specific contact via GET /events?type=user. Identify the contact by user_id, intercom_user_id, or email.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      user_id: z.string().optional().describe('Your external user ID.'),
      intercom_user_id: z.string().optional().describe('Intercom\'s internal contact ID.'),
      email: z.string().email().optional().describe('Contact email address.'),
      per_page: z.number().int().min(1).max(50).optional().describe('Events per page (max 50).'),
    },
    outputShape: {
      events: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListEvents({
        type: 'user',
        user_id: input.user_id,
        intercom_user_id: input.intercom_user_id,
        email: input.email,
        per_page: input.per_page,
      });
      const events = resp.events ?? resp.data ?? [];
      return {
        data: { events, count: events.length },
        summary: `Found ${events.length} event(s).`,
      };
    },
  }, callerHash);
}
