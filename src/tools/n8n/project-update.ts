import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProject } from '../../n8n/full-client.js';

export function registerN8nProjectUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_project_update',
    category: 'write_simple',
    annotations: {
      title: 'Update n8n project',
      description:
        'Rename an existing n8n project. Use n8n_project_list to find project IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('ID of the project to update.'),
      name: z.string().min(1).describe('New name for the project.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      name: z.string(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, name: input.name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would rename project ${input.project_id} to "${input.name}". Pass dry_run=false to apply.`,
        };
      }
      await updateProject({ projectId: input.project_id, name: input.name, correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, name: input.name },
        audit: { before: null, after: { project_id: input.project_id, name: input.name } },
        summary: `Updated project ${input.project_id} to name "${input.name}".`,
      };
    },
  }, callerHash);
}
