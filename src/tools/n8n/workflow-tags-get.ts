import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getWorkflowTags } from '../../n8n/full-client.js';

export function registerN8nWorkflowTagsGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_workflow_tags_get',
    category: 'read',
    annotations: {
      title: 'Get tags for an n8n workflow',
      description: 'List all tags currently applied to a specific n8n workflow. Use n8n_list_workflows to find workflow IDs.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      workflow_id: z.string().min(1).describe('Workflow ID whose tags to retrieve.'),
    },
    outputShape: {
      workflow_id: z.string(),
      tags: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      const tags = await getWorkflowTags(input.workflow_id, { correlationId: ctx.correlationId });
      const tagArray = Array.isArray(tags) ? tags : (tags?.data ?? []);
      return {
        data: { workflow_id: input.workflow_id, tags: tagArray, count: tagArray.length },
        summary: `Workflow ${input.workflow_id} has ${tagArray.length} tag(s).`,
      };
    },
  }, callerHash);
}
