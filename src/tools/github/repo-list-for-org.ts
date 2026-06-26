import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { repoListForOrg } from '../../github/full-client.js';

export function registerGitHubRepoListForOrg(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_list_for_org',
    category: 'read',
    annotations: {
      title: 'GitHub: list org repositories',
      description: 'List repositories visible to the App installation for a GitHub organisation. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      org: z.string().describe('Organisation login.'),
      type: z.enum(['all', 'public', 'private', 'forks', 'sources', 'member']).optional().describe('Filter by type (default: all).'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      repos: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const repos = await repoListForOrg(input.org, input.type ?? 'all', input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          repos: repos.map((r: any) => ({ id: r.id, name: r.name, full_name: r.full_name, private: r.private, default_branch: r.default_branch, url: r.html_url })),
          count: repos.length,
        },
        summary: `${repos.length} repo(s) for org ${input.org}`,
      };
    },
  }, callerHash);
}
