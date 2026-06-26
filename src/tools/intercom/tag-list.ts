import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { fcListTags } from '../../intercom/full-client.js';

export function registerIntercomTagList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'intercom_tag_list',
    category: 'read',
    annotations: {
      title: 'List all Intercom tags',
      description: 'Retrieve all tags defined in the Intercom workspace via GET /tags.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {},
    outputShape: {
      tags: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (_input, _ctx) => {
      const resp = await fcListTags();
      const tags = resp.data ?? resp.tags ?? [];
      return {
        data: { tags, count: tags.length },
        summary: `Found ${tags.length} tag(s).`,
      };
    },
  }, callerHash);
}
