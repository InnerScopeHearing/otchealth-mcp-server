import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { prListCommits } from '../../github/full-client.js';

export function registerGitHubPrListCommits(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_list_commits',
    category: 'read',
    annotations: {
      title: 'GitHub: list pull request commits',
      description: 'List commits included in a pull request. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      commits: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const commits = await prListCommits(input.owner, input.repo, input.pull_number, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          commits: commits.map((c: any) => ({ sha: c.sha, message: c.commit?.message?.split('\n')[0], author: c.commit?.author?.name, date: c.commit?.author?.date })),
          count: commits.length,
        },
        summary: `${commits.length} commit(s) in PR #${input.pull_number}`,
      };
    },
  }, callerHash);
}
