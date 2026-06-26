import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { transferWorkflow } from '../../n8n/full-client.js';

export function registerN8nWorkflowTransfer(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_workflow_transfer',
    category: 'write_orchestrated',
    annotations: {
      title: 'Transfer n8n workflow to another project',
      description:
        'Transfer ownership of an n8n workflow to a different project. Use n8n_project_list to find destination project IDs. ' +
        'This re-parents the workflow and may affect credential access scoping. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('ID of the workflow to transfer.'),
      destination_project_id: z.string().min(1).describe('Target project ID to receive the workflow.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string(),
      destination_project_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: {
            executed: false, dry_run: true,
            workflow_id: input.workflow_id,
            destination_project_id: input.destination_project_id,
            upstream_result: null,
          },
          audit: { before: null, after: input },
          summary: `DRY RUN: would transfer workflow ${input.workflow_id} to project ${input.destination_project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await transferWorkflow(
        input.workflow_id,
        input.destination_project_id,
        { correlationId: ctx.correlationId },
      );
      return {
        data: {
          executed: true, dry_run: false,
          workflow_id: input.workflow_id,
          destination_project_id: input.destination_project_id,
          upstream_result: upstream,
        },
        audit: { before: null, after: input },
        summary: `Transferred workflow ${input.workflow_id} to project ${input.destination_project_id}.`,
      };
    },
  }, callerHash);
}
