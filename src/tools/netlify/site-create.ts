import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createSite } from '../../netlify/full-client.js';

export function registerNetlifySiteCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'netlify_site_create',
    category: 'write_simple',
    annotations: {
      title: 'Netlify: create site',
      description: 'Create a new Netlify site (POST /sites). Optionally link a git repo and set a custom domain. Defaults to dry_run.',
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    },
    inputShape: {
      name: z.string().optional().describe('Subdomain name for the site (e.g. "my-app" → my-app.netlify.app).'),
      custom_domain: z.string().optional().describe('Custom domain to assign (e.g. "app.example.com").'),
      account_slug: z.string().optional().describe('Account slug/team to create the site under. Defaults to personal account.'),
      repo_provider: z.string().optional().describe('Repo provider: "github", "gitlab", "bitbucket".'),
      repo_id: z.number().int().optional().describe('Repository ID from the provider.'),
      repo_branch: z.string().optional().describe('Branch to deploy. Required if repo_id is set.'),
      build_cmd: z.string().optional().describe('Build command (e.g. "npm run build").'),
      publish_dir: z.string().optional().describe('Publish directory (e.g. "dist").'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.string().optional(),
      name: z.string().optional(),
      url: z.string().optional(),
      state: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create Netlify site${input.name ? ` "${input.name}"` : ''}. Pass dry_run=false to apply.`,
        };
      }
      const repoOpts = input.repo_id && input.repo_branch
        ? { provider: input.repo_provider ?? 'github', id: input.repo_id, branch: input.repo_branch, cmd: input.build_cmd, dir: input.publish_dir }
        : undefined;
      const site = await createSite({
        name: input.name,
        custom_domain: input.custom_domain,
        account_slug: input.account_slug,
        repo: repoOpts,
      });
      return {
        data: { executed: true, dry_run: false, id: site.id, name: site.name, url: site.url ?? site.ssl_url, state: site.state },
        audit: { before: null, after: site },
        summary: `Created Netlify site "${site.name}" (${site.id}): ${site.url ?? '(pending)'}`,
      };
    },
  }, callerHash);
}
