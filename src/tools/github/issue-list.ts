import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueList } from '../../github/full-client.js';
import { assertRepoAllowed } from '../../github/api-client.js';

export function registerGitHubIssueList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_list',
    category: 'read',
    annotations: {
      title: 'GitHub: list issues',
      description: 'List issues for a repository (excludes pull requests). Supports state and label filters. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter (default: open).'),
      labels: z.string().optional().describe('Comma-separated label names to filter by.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 20).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      issues: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const issues = await issueList(input.owner, input.repo, input.state ?? 'open', input.labels, input.per_page ?? 20, input.page ?? 1);
      // GitHub issues endpoint returns PRs too; filter them out
      const issuesOnly = issues.filter((i: any) => !i.pull_request);
      return {
        data: {
          issues: issuesOnly.map((i: any) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            user: i.user?.login,
            labels: (i.labels ?? []).map((l: any) => l.name),
            url: i.html_url,
            created_at: i.created_at,
          })),
          count: issuesOnly.length,
        },
        summary: `${issuesOnly.length} issue(s) in ${input.owner}/${input.repo} (${input.state ?? 'open'})`,
      };
    },
  }, callerHash);
}
