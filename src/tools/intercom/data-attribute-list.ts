import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListDataAttributes } from '../../intercom/full-client.js';

export function registerIntercomDataAttributeList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_data_attribute_list',
    category: 'read',
    annotations: {
      title: 'List Intercom data attributes',
      description: 'Retrieve all custom and default data attributes for contacts, companies, or conversations via GET /data_attributes.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      model: z.enum(['contact', 'company', 'conversation']).optional().describe('Filter by model type.'),
      include_archived: z.boolean().optional().describe('Include archived attributes (default: false).'),
    },
    outputShape: {
      attributes: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, _ctx) => {
      const resp = await fcListDataAttributes({
        model: input.model,
        include_archived: input.include_archived,
      });
      const attributes = resp.data ?? resp.data_attributes ?? [];
      return {
        data: { attributes, count: attributes.length },
        summary: `Found ${attributes.length} data attribute(s).`,
      };
    },
  }, callerHash);
}
