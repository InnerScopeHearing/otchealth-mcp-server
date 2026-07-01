import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createProject } from '../../depot/full-client.js';

export function registerDepotProjectCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_project_create',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot: create project',
      description: 'Create a new Depot build project for isolated builder infrastructure and cache. Defaults to dry_run. CTO-only (provisions build compute).',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      name: z.string().describe('Human-readable name for the new project.'),
      region_id: z.enum(['us-east-1', 'eu-central-1']).describe('AWS region for the builder infrastructure.'),
      cache_keep_bytes: z.number().optional().describe('Cache retention size in bytes (e.g. 53687091200 = 50 GB). Defaults to Depot default.'),
      cache_keep_days: z.number().optional().describe('Cache retention in days (e.g. 14). Defaults to Depot default.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      project_id: z.string().optional(),
      name: z.string().optional(),
      region_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, name: input.name, region_id: input.region_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create Depot project "${input.name}" in ${input.region_id}. Pass dry_run=false to apply.`,
        };
      }
      const cachePolicy: Record<string, number> = {};
      if (input.cache_keep_bytes) cachePolicy.keepBytes = input.cache_keep_bytes;
      if (input.cache_keep_days) cachePolicy.keepDays = input.cache_keep_days;
      const result = await createProject({
        name: input.name,
        regionId: input.region_id,
        ...(Object.keys(cachePolicy).length ? { cachePolicy } : {}),
      });
      const proj = result?.project ?? result;
      return {
        data: { executed: true, dry_run: false, project_id: proj?.projectId, name: proj?.name, region_id: proj?.regionId },
        audit: { before: null, after: proj },
        summary: `Created Depot project "${proj?.name}" (ID: ${proj?.projectId}) in ${proj?.regionId}.`,
      };
    },
  }, callerHash);
}
