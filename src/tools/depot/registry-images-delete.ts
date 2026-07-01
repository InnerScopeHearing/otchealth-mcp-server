import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { deleteRegistryImages } from '../../depot/full-client.js';

export function registerDepotRegistryImagesDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'depot_registry_images_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'Depot: delete registry images',
      description: 'Delete one or more container images from the Depot Registry by digest. IRREVERSIBLE. Defaults to dry_run. CTO-only.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      project_id: z.string().describe('The Depot project ID.'),
      digests: z.array(z.string()).min(1).describe('Array of image digests to delete (from depot_registry_images_list).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deleted_count: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deleted_count: input.digests.length },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete ${input.digests.length} image(s) from Depot Registry project ${input.project_id}. Pass dry_run=false to apply.`,
        };
      }
      await deleteRegistryImages({ projectId: input.project_id, digests: input.digests });
      return {
        data: { executed: true, dry_run: false, deleted_count: input.digests.length },
        audit: { before: { digests: input.digests }, after: null },
        summary: `Deleted ${input.digests.length} image(s) from Depot Registry project ${input.project_id}.`,
      };
    },
  }, callerHash);
}
