import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { getProject } from '../../n8n/full-client.js';

export function registerN8nProjectGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_project_get',
    category: 'read',
    annotations: {
      title: 'Get n8n project',
      description: 'Retrieve details of a single n8n project by ID. Use n8n_project_list to find project IDs.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('Project ID to retrieve (from n8n_project_list).'),
    },
    outputShape: {
      project: z.unknown(),
    },
    handler: async (input, ctx) => {
      const project = await getProject(input.project_id, { correlationId: ctx.correlationId });
      return {
        data: { project },
        summary: `Retrieved project ${input.project_id} ("${project?.name ?? 'unknown'}").`,
      };
    },
  }, callerHash);
}
