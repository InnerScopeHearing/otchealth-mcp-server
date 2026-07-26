import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { repoGet } from '../../github/full-client.js';
import { assertRepoAllowed } from '../../github/api-client.js';

export function registerGitHubRepoGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get repository',
      description: 'Retrieve full metadata for a GitHub repository (description, topics, default branch, stats, visibility). Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner (user or org).'),
      repo: z.string().describe('Repository name.'),
    },
    outputShape: {
      id: z.number().optional(),
      full_name: z.string().optional(),
      description: z.string().nullable().optional(),
      private: z.boolean().optional(),
      default_branch: z.string().optional(),
      language: z.string().nullable().optional(),
      stargazers_count: z.number().optional(),
      open_issues_count: z.number().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const r = await repoGet(input.owner, input.repo);
      return {
        data: {
          id: r.id,
          full_name: r.full_name,
          description: r.description,
          private: r.private,
          default_branch: r.default_branch,
          language: r.language,
          stargazers_count: r.stargazers_count,
          open_issues_count: r.open_issues_count,
          url: r.html_url,
        },
        summary: `Repository ${r.full_name} (${r.visibility ?? (r.private ? 'private' : 'public')}, default branch: ${r.default_branch})`,
      };
    },
  }, callerHash);
}
