import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { prListReviews } from '../../github/full-client.js';

export function registerGitHubPrListReviews(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_list_reviews',
    category: 'read',
    annotations: {
      title: 'GitHub: list pull request reviews',
      description: 'List all reviews submitted on a pull request. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
    },
    outputShape: {
      reviews: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const reviews = await prListReviews(input.owner, input.repo, input.pull_number);
      return {
        data: {
          reviews: reviews.map((r: any) => ({ id: r.id, user: r.user?.login, state: r.state, submitted_at: r.submitted_at, body: r.body })),
          count: reviews.length,
        },
        summary: `${reviews.length} review(s) on PR #${input.pull_number}`,
      };
    },
  }, callerHash);
}
