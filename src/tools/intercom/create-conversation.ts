import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createConversation } from '../../intercom/write-client.js';

export function registerIntercomCreateConversation(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_create_conversation',
    category: 'write_simple',
    annotations: {
      title: 'Create an Intercom conversation',
      description: 'Open a new inbound conversation in Intercom on behalf of a contact via POST /conversations. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      from_contact_id: z.string().describe('Intercom contact id that the conversation is opened from. Use intercom_create_contact or list contacts to obtain.'),
      body: z.string().describe('Opening message body (plain text or HTML).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conversation_id: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conversation_id: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create conversation from contact ${input.from_contact_id}. Pass dry_run=false to apply.`,
        };
      }
      const resp = await createConversation({
        from_contact_id: input.from_contact_id,
        body: input.body,
      });
      const convId = resp.conversation_id ?? resp.id ?? null;
      return {
        data: { executed: true, dry_run: false, conversation_id: convId },
        audit: { before: null, after: input },
        summary: `Conversation created (id: ${convId ?? 'unknown'}).`,
      };
    },
  }, callerHash);
}
