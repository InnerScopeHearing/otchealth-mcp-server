import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { cancelWorkflow } from '../../depot/full-client.js';

export function registerDepotWorkflowCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_workflow_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot CI: cancel workflow',
      description: 'Cancel a queued or running Depot CI workflow and all its child jobs. Defaults to dry_run. CTO-only (terminates compute).',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().describe('The Depot CI workflow ID to cancel.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string().optional(),
      status: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, workflow_id: input.workflow_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel Depot CI workflow ${input.workflow_id}. Pass dry_run=false to apply.`,
        };
      }
      const result = await cancelWorkflow({ workflowId: input.workflow_id });
      return {
        data: { executed: true, dry_run: false, workflow_id: result?.workflowId, status: result?.status },
        audit: { before: null, after: result },
        summary: `Cancelled Depot CI workflow ${input.workflow_id}. Status: ${result?.status}.`,
      };
    },
  }, callerHash);
}
