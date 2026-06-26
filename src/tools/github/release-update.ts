import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releaseUpdate } from '../../github/full-client.js';

export function registerGitHubReleaseUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_release_update',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update release',
      description: 'Update a release name, body, draft/prerelease flags, or tag. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      release_id: z.number().int().describe('Release numeric ID.'),
      tag_name: z.string().optional().describe('New tag name.'),
      name: z.string().optional().describe('New release name.'),
      body: z.string().optional().describe('New release notes (Markdown).'),
      draft: z.boolean().optional().describe('Mark as draft (true) or publish (false).'),
      prerelease: z.boolean().optional().describe('Mark as prerelease.'),
      make_latest: z.enum(['true', 'false', 'legacy']).optional().describe('Control whether this becomes the latest release.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      id: z.number().optional(),
      tag_name: z.string().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, id: input.release_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update release ${input.release_id} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await releaseUpdate(input.owner, input.repo, input.release_id, {
        tagName: input.tag_name,
        name: input.name,
        body: input.body,
        draft: input.draft,
        prerelease: input.prerelease,
        makeLatest: input.make_latest,
      });
      return {
        data: { executed: true, dry_run: false, id: r.id, tag_name: r.tag_name, url: r.html_url },
        audit: { before: { id: input.release_id }, after: { tag_name: r.tag_name } },
        summary: `Updated release ${r.id} (${r.tag_name}) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
