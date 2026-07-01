import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { resetProject } from '../../depot/full-client.js';

export function registerDepotProjectReset(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_reset',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot: reset project cache',
      description: 'Reset a Depot project — terminates all builder machines and purges all cached layer data. Cache starts empty on next build. IRREVERSIBLE. Defaults to dry_run. CTO-only.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('ID of the project whose cache to reset.'),
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
          summary: `DRY RUN: would reset (purge all cache) for Depot project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await resetProject({ projectId: input.project_id });
      return {
        data: { executed: true, dry_run: false, project_id: input.project_id },
        audit: { before: { project_id: input.project_id }, after: null },
        summary: `Reset Depot project ${input.project_id} — cache purged, builders terminated.`,
      };
    },
  }, callerHash);
}
