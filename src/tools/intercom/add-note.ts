import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { addNote } from '../../intercom/write-client.js';

export function registerIntercomAddNote(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_add_note',
    category: 'write_simple',
    annotations: {
      title: 'Add an internal note to an Intercom conversation',
      description: 'Post an internal note (not visible to the customer) on an Intercom conversation via POST /conversations/{id}/reply with message_type=note. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      conversation_id: z.string().describe('Intercom conversation id to annotate.'),
      body: z.string().describe('Internal note body (plain text or HTML).'),
      admin_id: z.string().describe('Intercom admin id of the note author. Required by Intercom for all note writes.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      conversation_id: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, conversation_id: input.conversation_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would add internal note to conversation ${input.conversation_id}. Pass dry_run=false to apply.`,
        };
      }
      await addNote({
        conversation_id: input.conversation_id,
        body: input.body,
        admin_id: input.admin_id,
      });
      return {
        data: { executed: true, dry_run: false, conversation_id: input.conversation_id },
        audit: { before: null, after: input },
        summary: `Internal note added to conversation ${input.conversation_id}.`,
      };
    },
  }, callerHash);
}
