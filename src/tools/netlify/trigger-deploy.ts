import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { triggerDeploy } from '../../netlify/write-client.js';

/**
 * netlify_trigger_deploy — kick off a new Netlify build from the linked repository.
 * write_orchestrated (production deploy). CTO-gated; honors dry_run.
 */
export function registerNetlifyTriggerDeploy(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'netlify_trigger_deploy',
      category: 'write_orchestrated',
      annotations: {
        title: 'Netlify: trigger deploy (build from repo)',
        description:
          'Trigger a new Netlify build for a site from its linked repository (POST /api/v1/sites/{id}/builds). Optionally specify a branch or clear the build cache. Defaults to dry_run. CTO-only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        site_id: z
          .string()
          .min(1)
          .describe('Netlify site ID (UUID). Use netlify_list_sites to find it.'),
        branch: z
          .string()
          .optional()
          .describe('Git branch to build. Defaults to the site production branch.'),
        clear_cache: z
          .boolean()
          .optional()
          .describe('Clear the build cache before building. Default: false.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        id: z.string().optional(),
        deploy_id: z.string().optional(),
        done: z.boolean().optional(),
        sha: z.string().optional(),
        created_at: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true },
            audit: { before: null, after: input },
            summary: `DRY RUN: would trigger deploy for Netlify site ${input.site_id}${input.branch ? ` (branch: ${input.branch})` : ''}. Pass dry_run=false to execute.`,
          };
        }
        const r = await triggerDeploy({
          siteId: input.site_id,
          branch: input.branch,
          clearCache: input.clear_cache,
        });
        return {
          data: {
            executed: true,
            dry_run: false,
            id: r.id,
            deploy_id: r.deployId,
            done: r.done,
            sha: r.sha,
            created_at: r.createdAt,
          },
          audit: { before: null, after: r },
          summary: `Triggered deploy for Netlify site ${input.site_id} (build id: ${r.id}).`,
        };
      },
    },
    callerHash,
  );
}
