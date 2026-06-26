import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteExecution } from '../../n8n/full-client.js';

export function registerN8nExecutionDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_execution_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete n8n execution record',
      description:
        'Permanently delete an n8n execution record by its numeric ID. This removes the execution log entry; it does NOT stop a currently-running execution. ' +
        'Irreversible. Use n8n_execution_list to find execution IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      execution_id: z.union([z.string(), z.number()]).describe('Execution ID to delete (numeric or string).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      execution_id: z.union([z.string(), z.number()]),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, execution_id: input.execution_id, upstream_result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete execution ${input.execution_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteExecution(input.execution_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, execution_id: input.execution_id, upstream_result: upstream },
        audit: { before: { execution_id: input.execution_id }, after: null },
        summary: `Deleted execution ${input.execution_id}.`,
      };
    },
  }, callerHash);
}
