import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getTag } from '../../n8n/full-client.js';

export function registerN8nTagGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_tag_get',
    category: 'read',
    annotations: {
      title: 'Get n8n tag',
      description: 'Retrieve a single n8n tag by its ID. Use n8n_tag_list to find tag IDs.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      tag_id: z.string().min(1).describe('Tag ID to retrieve (from n8n_tag_list).'),
    },
    outputShape: {
      tag: z.unknown(),
    },
    handler: async (input, ctx) => {
      const tag = await getTag(input.tag_id, { correlationId: ctx.correlationId });
      return {
        data: { tag },
        summary: `Retrieved tag ${input.tag_id} ("${tag?.name ?? 'unknown'}").`,
      };
    },
  }, callerHash);
}
