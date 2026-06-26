import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listWorkflowsFiltered } from '../../n8n/full-client.js';

export function registerN8nWorkflowListFiltered(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_workflow_list_filtered',
    category: 'read',
    annotations: {
      title: 'List n8n workflows (with project filter)',
      description:
        'List n8n workflows with extended filters including projectId. Use this instead of n8n_list_workflows when you need to scope results to a specific project. Returns id, name, active, tags, timestamps.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      active: z.boolean().optional().describe('Filter to active (true) or inactive (false) workflows only.'),
      tags: z.string().optional().describe('Comma-separated tag names to filter by.'),
      name: z.string().optional().describe('Partial name match filter.'),
      project_id: z.string().optional().describe('Filter workflows belonging to this project ID.'),
      limit: z.number().int().min(1).max(250).optional().describe('Max results (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
    },
    outputShape: {
      workflows: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listWorkflowsFiltered({
        active: input.active,
        tags: input.tags,
        name: input.name,
        projectId: input.project_id,
        limit: input.limit,
        cursor: input.cursor,
        correlationId: ctx.correlationId,
      });
      const workflows = raw?.data ?? [];
      return {
        data: { workflows, count: workflows.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${workflows.length} workflow(s).`,
      };
    },
  }, callerHash);
}
