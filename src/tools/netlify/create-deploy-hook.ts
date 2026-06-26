import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createDeployHook } from '../../netlify/write-client.js';

/**
 * netlify_create_deploy_hook — create a Netlify build hook URL.
 * write_simple (creates a webhook; trigger is separate). CTO-gated via governance; honors dry_run.
 *
 * The returned URL can later be POSTed to from CI/CD or other automation to
 * trigger a build without further Netlify auth.
 */
export function registerNetlifyCreateDeployHook(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'netlify_create_deploy_hook',
      category: 'write_simple',
      annotations: {
        title: 'Netlify: create deploy hook (build webhook)',
        description:
          'Create a Netlify build hook — a secret webhook URL that triggers a new deploy when POSTed to. Useful for external CI, cron jobs, or n8n workflows. Defaults to dry_run.',
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
        title: z.string().min(1).describe('Human-readable label for the hook, e.g. "n8n nightly trigger".'),
        branch: z
          .string()
          .optional()
          .describe('Git branch this hook will build. Defaults to the site production branch.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        id: z.string().optional(),
        title: z.string().optional(),
        branch: z.string().optional(),
        url: z.string().optional(),
        created_at: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create deploy hook "${input.title}" for Netlify site ${input.site_id}. Pass dry_run=false to execute.`,
          };
        }
        const r = await createDeployHook({
          siteId: input.site_id,
          title: input.title,
          branch: input.branch,
        });
        return {
          data: {
            executed: true,
            dry_run: false,
            id: r.id,
            title: r.title,
            branch: r.branch,
            url: r.url,
            created_at: r.createdAt,
          },
          audit: { before: null, after: { id: r.id, title: r.title, branch: r.branch } },
          summary: `Created deploy hook "${r.title}" (id: ${r.id}) for Netlify site ${input.site_id}. Trigger URL is in the url field.`,
        };
      },
    },
    callerHash,
  );
}
