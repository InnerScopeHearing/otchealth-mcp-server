import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listExecutions } from '../../n8n/full-client.js';

export function registerN8nExecutionList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_execution_list',
    category: 'read',
    annotations: {
      title: 'List n8n executions',
      description:
        'List n8n workflow executions with optional filters by workflow ID, status (error/success/waiting/running), and pagination. ' +
        'Returns execution metadata including status, start/finish times, and workflow reference.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().optional().describe('Filter executions for a specific workflow ID.'),
      status: z
        .enum(['error', 'success', 'waiting', 'running'])
        .optional()
        .describe('Filter by execution status.'),
      limit: z.number().int().min(1).max(250).optional().describe('Max results to return (default 20).'),
      cursor: z.string().optional().describe('Pagination cursor from previous response.'),
      include_data: z.boolean().optional().describe('Include full execution data (large — use sparingly).'),
    },
    outputShape: {
      executions: z.array(z.unknown()),
      count: z.number(),
      next_cursor: z.string().nullable(),
    },
    handler: async (input, ctx) => {
      const raw = await listExecutions({
        workflowId: input.workflow_id,
        status: input.status,
        limit: input.limit,
        cursor: input.cursor,
        includeData: input.include_data,
        correlationId: ctx.correlationId,
      });
      const executions = raw?.data ?? [];
      return {
        data: { executions, count: executions.length, next_cursor: raw?.nextCursor ?? null },
        summary: `Found ${executions.length} execution(s).`,
      };
    },
  }, callerHash);
}
