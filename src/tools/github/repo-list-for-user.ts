import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { repoListForUser } from '../../github/full-client.js';

export function registerGitHubRepoListForUser(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_list_for_user',
    category: 'read',
    annotations: {
      title: 'GitHub: list user repositories',
      description: 'List public repositories for a GitHub user. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      username: z.string().describe('GitHub username.'),
      type: z.enum(['all', 'owner', 'member']).optional().describe('Filter by type (default: all).'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      repos: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const repos = await repoListForUser(input.username, input.type ?? 'all', input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          repos: repos.map((r: any) => ({ id: r.id, name: r.name, full_name: r.full_name, private: r.private, default_branch: r.default_branch, url: r.html_url })),
          count: repos.length,
        },
        summary: `${repos.length} repo(s) for user ${input.username}`,
      };
    },
  }, callerHash);
}
