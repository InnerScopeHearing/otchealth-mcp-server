import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcGetNote } from '../../intercom/full-client.js';

export function registerIntercomNoteGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_note_get',
    category: 'read',
    annotations: {
      title: 'Get an Intercom note by ID',
      description: 'Retrieve a single note by its ID via GET /notes/:id.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      note_id: z.string().describe('Intercom note ID.'),
    },
    outputShape: {
      note: z.unknown(),
    },
    handler: async (input, _ctx) => {
      const note = await fcGetNote(input.note_id);
      return {
        data: { note },
        summary: `Note ${input.note_id} retrieved.`,
      };
    },
  }, callerHash);
}
