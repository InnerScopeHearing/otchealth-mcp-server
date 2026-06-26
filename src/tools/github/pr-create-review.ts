import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prCreateReview } from '../../github/full-client.js';

export function registerGitHubPrCreateReview(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_create_review',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: submit pull request review',
      description: 'Submit an APPROVE, REQUEST_CHANGES, COMMENT, or PENDING review on a pull request. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
      event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT', 'PENDING']).describe('Review action.'),
      body: z.string().optional().describe('Review body text.'),
      commit_id: z.string().optional().describe('SHA of the commit to review.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      review_id: z.number().optional(),
      state: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would submit ${input.event} review on PR #${input.pull_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await prCreateReview({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        event: input.event,
        body: input.body,
        commitId: input.commit_id,
      });
      return {
        data: { executed: true, dry_run: false, review_id: r.id, state: r.state },
        audit: { before: null, after: r },
        summary: `Submitted ${r.state} review (id ${r.id}) on PR #${input.pull_number}`,
      };
    },
  }, callerHash);
}
