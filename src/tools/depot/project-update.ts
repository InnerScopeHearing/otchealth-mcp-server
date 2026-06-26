import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { updateProject } from '../../depot/full-client.js';

export function registerDepotProjectUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_update',
    category: 'write_simple',
    annotations: {
      title: 'Depot: update project',
      description: 'Update a Depot project name or cache policy. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('ID of the project to update.'),
      name: z.string().optional().describe('New project name.'),
      cache_keep_bytes: z.number().optional().describe('New cache retention size in bytes.'),
      cache_keep_days: z.number().optional().describe('New cache retention in days.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project: z.unknown().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update Depot project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      const cachePolicy: Record<string, number> = {};
      if (input.cache_keep_bytes) cachePolicy.keepBytes = input.cache_keep_bytes;
      if (input.cache_keep_days) cachePolicy.keepDays = input.cache_keep_days;
      const result = await updateProject({
        projectId: input.project_id,
        ...(input.name ? { name: input.name } : {}),
        ...(Object.keys(cachePolicy).length ? { cachePolicy } : {}),
      });
      return {
        data: { executed: true, dry_run: false, project: result?.project ?? result },
        audit: { before: null, after: input },
        summary: `Updated Depot project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
