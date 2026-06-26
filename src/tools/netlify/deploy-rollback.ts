import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { restoreDeploy } from '../../netlify/full-client.js';

export function registerNetlifyDeployRollback(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_deploy_rollback',
    category: 'write_orchestrated',
    annotations: {
      title: 'Netlify: rollback / restore deploy to production',
      description: 'Restore a previous deploy to production for a site (POST /sites/{site_id}/deploys/{deploy_id}/restore). Swaps the published deploy. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      site_id: z.string().min(1).describe('Netlify site ID.'),
      deploy_id: z.string().min(1).describe('Deploy ID to restore to production. Use netlify_list_site_deploys to find a previous deploy.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      deploy_id: z.string().optional(),
      state: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, deploy_id: input.deploy_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would restore deploy ${input.deploy_id} to production for site ${input.site_id}. Pass dry_run=false to apply.`,
        };
      }
      const d = await restoreDeploy(input.site_id, input.deploy_id);
      return {
        data: { executed: true, dry_run: false, deploy_id: d.id ?? input.deploy_id, state: d.state },
        audit: { before: null, after: d },
        summary: `Restored deploy ${d.id ?? input.deploy_id} to production for site ${input.site_id}.`,
      };
    },
  }, callerHash);
}
