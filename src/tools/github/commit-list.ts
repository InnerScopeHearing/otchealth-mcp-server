import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { commitList } from '../../github/full-client.js';

export function registerGitHubCommitList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_commit_list',
    category: 'read',
    annotations: {
      title: 'GitHub: list commits',
      description: 'List commits for a repository, optionally filtered by branch/SHA and file path. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      sha: z.string().optional().describe('Branch name, tag, or commit SHA to list commits from (default: default branch).'),
      path: z.string().optional().describe('Only commits that changed this file path.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 20).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      commits: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const commits = await commitList(input.owner, input.repo, input.sha, input.path, input.per_page ?? 20, input.page ?? 1);
      return {
        data: {
          commits: commits.map((c: any) => ({
            sha: c.sha,
            message: c.commit?.message?.split('\n')[0],
            author: c.commit?.author?.name,
            date: c.commit?.author?.date,
            url: c.html_url,
          })),
          count: commits.length,
        },
        summary: `${commits.length} commit(s) in ${input.owner}/${input.repo}${input.sha ? ` @ ${input.sha}` : ''}`,
      };
    },
  }, callerHash);
}
