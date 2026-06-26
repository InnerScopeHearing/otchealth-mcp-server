import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { repoListContributors } from '../../github/full-client.js';

export function registerGitHubRepoListContributors(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_list_contributors',
    category: 'read',
    annotations: {
      title: 'GitHub: list contributors',
      description: 'List contributors for a repository sorted by commit count. Read-only.',
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
      contributors: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const contributors = await repoListContributors(input.owner, input.repo, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          contributors: contributors.map((c: any) => ({ login: c.login, contributions: c.contributions, url: c.html_url })),
          count: contributors.length,
        },
        summary: `${contributors.length} contributor(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
