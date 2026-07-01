import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { repoListTags } from '../../github/full-client.js';

export function registerGitHubRepoListTags(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_list_tags',
    category: 'read',
    annotations: {
      title: 'GitHub: list tags',
      description: 'List tags for a repository. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      tags: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const tags = await repoListTags(input.owner, input.repo, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          tags: tags.map((t: any) => ({ name: t.name, sha: t.commit?.sha, zipball_url: t.zipball_url })),
          count: tags.length,
        },
        summary: `${tags.length} tag(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
