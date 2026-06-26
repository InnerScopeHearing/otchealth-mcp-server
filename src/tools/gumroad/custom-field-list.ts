import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listCustomFields } from '../../gumroad/full-client.js';

export function registerGumroadCustomFieldList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'gumroad_custom_field_list',
    category: 'read',
    annotations: {
      title: 'List Gumroad custom fields',
      description: 'List all custom checkout fields for a Gumroad product.',
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
    inputShape: {
      product_id: z.string().describe('Gumroad product ID.'),
    },
    outputShape: {
      custom_fields: z.array(z.record(z.unknown())),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await listCustomFields(input.product_id);
      const fields = resp.custom_fields ?? [];
      return {
        data: { custom_fields: fields, count: fields.length },
        summary: `${fields.length} custom field(s) for product ${input.product_id}.`,
      };
    },
  }, callerHash);
}
