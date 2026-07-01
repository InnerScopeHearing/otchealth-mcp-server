import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteProject } from '../../depot/full-client.js';

export function registerDepotProjectDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot: delete project',
      description: 'Permanently delete a Depot build project and all its cache. IRREVERSIBLE. Defaults to dry_run. CTO-only.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('ID of the project to permanently delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, project_id: input.project_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would PERMANENTLY DELETE Depot project ${input.project_id} and all its cache. Pass dry_run=false to apply.`,
        };
      }
      await deleteProject({ projectId: input.project_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id },
        audit: { before: { project_id: input.project_id }, after: null },
        summary: `Deleted Depot project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
