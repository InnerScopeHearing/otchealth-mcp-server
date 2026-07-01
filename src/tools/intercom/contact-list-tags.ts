import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListContactAttachedTags } from '../../intercom/full-client.js';

export function registerIntercomContactListTags(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_contact_list_tags',
    category: 'read',
    annotations: {
      title: 'List tags attached to an Intercom contact',
      description: 'Retrieve all tags associated with a specific Intercom contact via GET /contacts/:id/tags.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      contact_id: z.string().describe('Intercom contact ID.'),
    },
    outputShape: {
      tags: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListContactAttachedTags(input.contact_id);
      const tags = resp.data ?? resp.tags ?? [];
      return {
        data: { tags, count: tags.length },
        summary: `Contact ${input.contact_id} has ${tags.length} tag(s).`,
      };
    },
  }, callerHash);
}
