import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listVariables } from '../../n8n/full-client.js';

export function registerN8nVariableList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_variable_list',
    category: 'read',
    annotations: {
      title: 'List n8n variables',
      description:
        'List all n8n instance-level variables (key-value pairs accessible across all workflows). Returns id, key, value, and type.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      limit: z.number().int().min(1).max(250).optional().describe('Max results (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
    },
    outputShape: {
      variables: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listVariables({
        limit: input.limit,
        cursor: input.cursor,
        correlationId: ctx.correlationId,
      });
      const variables = raw?.data ?? [];
      return {
        data: { variables, count: variables.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${variables.length} variable(s).`,
      };
    },
  }, callerHash);
}
