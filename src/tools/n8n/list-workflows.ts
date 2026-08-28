import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { n8nGet } from '../../n8n/api-client.js';

interface WorkflowsResponse {
  data?: Array<{
    id: string;
    name?: string;
    active?: boolean;
    createdAt?: string;
    updatedAt?: string;
    tags?: Array<{ id?: string; name?: string }>;
  }>;
  nextCursor?: string | null;
}

export function registerN8nListWorkflows(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'n8n_list_workflows',
      category: 'read',
      annotations: {
        title: 'List n8n workflows',
        description:
          'List workflows on the n8n instance (cs-n8n.otchealthmart.com, AWS Lightsail recovery lane). Returns id, name, active flag, tags, and timestamps. Useful for ops debugging and finding workflow IDs.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        active: z.boolean().optional().describe('Filter to active=true or inactive=false workflows only.'),
        limit: z.number().int().min(1).max(250).optional(),
        cursor: z.string().optional().describe('Pagination cursor from previous response.'),
        name: z.string().optional().describe('Filter by partial name match.'),
        tag: z.string().optional().describe('Filter by tag name (e.g., production, dormant, customerio).'),
      },
      outputShape: {
        workflows: z.array(z.unknown()),
        count: z.number(),
        next_cursor: z.string().nullable(),
      },
      handler: async (input, ctx) => {
        const query: Record<string, string | number | undefined> = {};
        if (input.active !== undefined) query.active = input.active ? 'true' : 'false';
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.cursor !== undefined) query.cursor = input.cursor;
        if (input.name !== undefined) query.name = input.name;
        if (input.tag !== undefined) query.tags = input.tag;
        const data = await n8nGet<WorkflowsResponse>('/workflows', {
          query,
          correlationId: ctx.correlationId,
        });
        const workflows = data.data ?? [];
        return {
          data: {
            workflows,
            count: workflows.length,
            next_cursor: data.nextCursor ?? null,
          },
          summary: `Found ${workflows.length} workflow(s).`,
        };
      },
    },
    callerHash,
  );
}
