import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProject } from '../../n8n/full-client.js';

export function registerN8nProjectDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'n8n_project_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Delete n8n project',
      description:
        'Permanently delete an n8n project by ID. This removes the project and may cascade-delete or orphan all workflows and credentials within it depending on n8n version. Irreversible. ' +
        'Use n8n_project_list to find IDs. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().min(1).describe('ID of the project to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string(),
      upstream_result: z.unknown().nullable(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id, upstream_result: null },
          audit: { before: null, after: input },
          summary: `DRY RUN: would permanently delete project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const upstream = await deleteProject(input.project_id, { correlationId: ctx.correlationId });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id, upstream_result: upstream },
        audit: { before: { project_id: input.project_id }, after: null },
        summary: `Deleted project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
