import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { n8nGet } from '../../n8n/api-client.js';

interface ExecutionsListResponse {
  data?: Array<{
    id: number | string;
    finished?: boolean;
    mode?: string;
    status?: string;
    startedAt?: string;
    stoppedAt?: string | null;
    workflowId?: string;
    workflowName?: string;
  }>;
  nextCursor?: string | null;
}

export function registerN8nGetExecution(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'n8n_get_execution',
      category: 'read',
      annotations: {
        title: 'Get n8n execution(s)',
        description:
          'Fetch a specific execution by id, or list recent executions for a workflow. Useful for debugging post-call pipelines or verifying webhook deliveries. Returns status, finished flag, mode, timestamps, and (optionally) full execution data.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        execution_id: z
          .union([z.string(), z.number()])
          .optional()
          .describe('If provided, fetches just this execution.'),
        workflow_id: z.string().optional().describe('If provided without execution_id, lists recent executions for this workflow.'),
        limit: z.number().int().min(1).max(100).optional(),
        status: z.enum(['error', 'success', 'waiting']).optional(),
        include_data: z
          .boolean()
          .optional()
          .describe('If true and execution_id is set, includes the full execution data (large).'),
      },
      outputShape: {
        execution: z.unknown().nullable(),
        executions: z.array(z.unknown()).nullable(),
        count: z.number(),
      },
      handler: async (input, ctx) => {
        if (input.execution_id !== undefined) {
          const id = encodeURIComponent(String(input.execution_id));
          const query: Record<string, string | number | undefined> = {};
          if (input.include_data === true) query.includeData = 'true';
          const ex = await n8nGet<unknown>(`/executions/${id}`, {
            query,
            correlationId: ctx.correlationId,
          });
          return { data: { execution: ex, executions: null, count: 1 } };
        }
        const query: Record<string, string | number | undefined> = {};
        if (input.workflow_id !== undefined) query.workflowId = input.workflow_id;
        if (input.limit !== undefined) query.limit = input.limit;
        if (input.status !== undefined) query.status = input.status;
        const list = await n8nGet<ExecutionsListResponse>('/executions', {
          query,
          correlationId: ctx.correlationId,
        });
        const executions = list.data ?? [];
        return {
          data: { execution: null, executions, count: executions.length },
          summary: `Found ${executions.length} execution(s).`,
        };
      },
    },
    callerHash,
  );
}
