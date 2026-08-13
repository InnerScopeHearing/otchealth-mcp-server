import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { releaseGet } from '../../github/full-client.js';

export function registerGitHubReleaseGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_release_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get release by ID',
      description: 'Get full details for a single release by its numeric ID. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      release_id: z.number().int().describe('Release numeric ID.'),
    },
    outputShape: {
      id: z.number().optional(),
      tag_name: z.string().optional(),
      name: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      draft: z.boolean().optional(),
      prerelease: z.boolean().optional(),
      published_at: z.string().nullable().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const r = await releaseGet(input.owner, input.repo, input.release_id);
      return {
        data: { id: r.id, tag_name: r.tag_name, name: r.name, body: r.body, draft: r.draft, prerelease: r.prerelease, published_at: r.published_at, url: r.html_url },
        summary: `Release ${r.tag_name} (id ${r.id}) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
