import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prRequestReviewers } from '../../github/full-client.js';

export function registerGitHubPrRequestReviewers(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_request_reviewers',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: request PR reviewers',
      description: 'Request specific users or teams to review a pull request. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
      reviewers: z.array(z.string()).optional().describe('GitHub usernames to request as reviewers.'),
      team_reviewers: z.array(z.string()).optional().describe('Team slugs to request as reviewers.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      requested: z.array(z.string()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, requested: [...(input.reviewers ?? []), ...(input.team_reviewers ?? [])] },
          audit: { before: null, after: input },
          summary: `DRY RUN: would request reviewers on PR #${input.pull_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await prRequestReviewers({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        reviewers: input.reviewers,
        teamReviewers: input.team_reviewers,
      });
      const requested = [
        ...((r.requested_reviewers ?? []) as any[]).map((u: any) => u.login),
        ...((r.requested_teams ?? []) as any[]).map((t: any) => t.slug),
      ];
      return {
        data: { executed: true, dry_run: false, requested },
        audit: { before: null, after: { requested } },
        summary: `Requested ${requested.length} reviewer(s) on PR #${input.pull_number}: ${requested.join(', ')}`,
      };
    },
  }, callerHash);
}
