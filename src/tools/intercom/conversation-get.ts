import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetConversation } from '../../intercom/full-client.js';

export function registerIntercomConversationGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_conversation_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom conversation by ID',
      description: 'Retrieve full details of a single Intercom conversation including parts (messages), tags, and assignee.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation ID.'),
    },
    outputShape: {
      conversation: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const conversation = await fcGetConversation(input.conversation_id);
      return {
        data: { conversation },
        summary: `Conversation ${input.conversation_id} retrieved.`,
      };
    },
  }, callerHash);
}
