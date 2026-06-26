import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteWorkflow } from '../../n8n/full-client.js';

export function registerN8nWorkflowDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_workflow_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete n8n workflow',
      description:
        'Permanently delete an n8n workflow by ID. This is irreversible — all nodes, connections, and execution history for the workflow are removed. ' +
        'Deactivate the workflow first with n8n_deactivate_workflow. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('ID of the n8n workflow to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, workflow_id: input.workflow_id, upstream_result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteWorkflow(input.workflow_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, workflow_id: input.workflow_id, upstream_result: upstream },
        audit: { before: { workflow_id: input.workflow_id }, after: null },
        summary: `Deleted workflow ${input.workflow_id}.`,
      };
    },
  }, callerHash);
}
