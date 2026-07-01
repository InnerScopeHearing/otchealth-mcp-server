import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueListComments } from '../../github/full-client.js';

export function registerGitHubIssueListComments(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_list_comments',
    category: 'read',
    annotations: {
      title: 'GitHub: list issue comments',
      description: 'List comments on an issue or pull request. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issue_number: z.number().int().describe('Issue or pull request number.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      comments: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const comments = await issueListComments(input.owner, input.repo, input.issue_number, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          comments: comments.map((c: any) => ({ id: c.id, user: c.user?.login, body: c.body, created_at: c.created_at, url: c.html_url })),
          count: comments.length,
        },
        summary: `${comments.length} comment(s) on #${input.issue_number} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
