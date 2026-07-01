import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listTags } from '../../n8n/full-client.js';

export function registerN8nTagList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_tag_list',
    category: 'read',
    annotations: {
      title: 'List n8n tags',
      description:
        'List all tags defined in the n8n instance, optionally including usage counts. Returns id, name, and (optionally) how many workflows use each tag.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().describe('Max results (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
      with_usage_count: z.boolean().optional().describe('Include the count of workflows using each tag.'),
    },
    outputShape: {
      tags: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listTags({
        limit: input.limit,
        cursor: input.cursor,
        withUsageCount: input.with_usage_count,
        correlationId: ctx.correlationId,
      });
      const tags = raw?.data ?? [];
      return {
        data: { tags, count: tags.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${tags.length} tag(s).`,
      };
    },
  }, callerHash);
}
