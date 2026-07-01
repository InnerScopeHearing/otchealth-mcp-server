import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListConversations } from '../../intercom/full-client.js';

export function registerIntercomConversationList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_list',
    category: 'read',
    annotations: {
      title: 'List Intercom conversations',
      description: 'Paginated list of conversations in the Intercom workspace. Filter by state (open/closed/snoozed) and assignee.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      per_page: z.number().int().min(1).max(150).optional().describe('Conversations per page (max 150).'),
      starting_after: z.string().optional().describe('Cursor for next page.'),
      state: z.enum(['open', 'closed', 'snoozed']).optional().describe('Filter by conversation state.'),
      assignee_id: z.string().optional().describe('Filter by assigned admin ID.'),
    },
    outputShape: {
      conversations: z.array(z.unknown()),
      count: z.number(),
      total_count: z.number().nullable(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListConversations({
        per_page: input.per_page,
        starting_after: input.starting_after,
        state: input.state,
        assignee_id: input.assignee_id,
      });
      const conversations = resp.conversations ?? resp.data ?? [];
      return {
        data: {
          conversations,
          count: conversations.length,
          total_count: resp.total_count ?? null,
          next_cursor: resp.pages?.next?.starting_after ?? null,
        },
        summary: `Found ${conversations.length} conversation(s).`,
      };
    },
  }, callerHash);
}
