import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListContactNotes } from '../../intercom/full-client.js';

export function registerIntercomNoteList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_note_list',
    category: 'read',
    annotations: {
      title: 'List notes on an Intercom contact',
      description: 'Retrieve all notes associated with a specific Intercom contact via GET /contacts/:id/notes.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID to list notes for.'),
    },
    outputShape: {
      notes: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListContactNotes(input.contact_id);
      const notes = resp.data ?? resp.notes ?? [];
      return {
        data: { notes, count: notes.length },
        summary: `Contact ${input.contact_id} has ${notes.length} note(s).`,
      };
    },
  }, callerHash);
}
