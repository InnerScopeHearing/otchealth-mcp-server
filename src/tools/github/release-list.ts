import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releaseList } from '../../github/full-client.js';

export function registerGitHubReleaseList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_release_list',
    category: 'read',
    annotations: {
      title: 'GitHub: list releases',
      description: 'List published releases for a repository. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 20).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      releases: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const releases = await releaseList(input.owner, input.repo, input.per_page ?? 20, input.page ?? 1);
      return {
        data: {
          releases: releases.map((r: any) => ({ id: r.id, tag_name: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease, published_at: r.published_at, url: r.html_url })),
          count: releases.length,
        },
        summary: `${releases.length} release(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
