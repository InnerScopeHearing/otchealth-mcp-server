import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getWorkflow } from '../../n8n/full-client.js';

export function registerN8nWorkflowGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_workflow_get',
    category: 'read',
    annotations: {
      title: 'Get n8n workflow',
      description:
        'Retrieve the full definition of a single n8n workflow by its ID, including nodes, connections, settings, and tags. Use n8n_list_workflows to find workflow IDs.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('n8n workflow ID (from n8n_list_workflows).'),
    },
    outputShape: {
      workflow: z.unknown(),
    },
    handler: async (input, ctx) => {
      const workflow = await getWorkflow(input.workflow_id, { correlationId: ctx.correlationId });
      return {
        data: { workflow },
        summary: `Retrieved workflow ${input.workflow_id} ("${workflow?.name ?? 'unknown'}").`,
      };
    },
  }, callerHash);
}
