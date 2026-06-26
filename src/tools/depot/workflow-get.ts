import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getWorkflow } from '../../depot/full-client.js';

export function registerDepotWorkflowGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_workflow_get',
    category: 'read',
    annotations: {
      title: 'Depot CI: get workflow',
      description: 'Get full details of a Depot CI workflow including status, timestamps, parent run context, execution history, and nested jobs/attempts. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().describe('The Depot CI workflow ID.'),
    },
    outputShape: {
      workflow: z.unknown(),
    },
    handler: async (input) => {
      const result = await getWorkflow({ workflowId: input.workflow_id });
      return {
        data: { workflow: result },
        summary: `Workflow ${input.workflow_id}: status=${result?.workflowStatus}.`,
      };
    },
  }, callerHash);
}
