import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prMarkReadyForReview } from '../../github/full-client.js';

/** A narrow Chat-native equivalent of GitHub's "Ready for review" action. */
export function registerGitHubPrMarkReadyForReview(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_mark_ready_for_review',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: mark draft pull request ready for review',
      description: 'Change only a draft pull request to ready for review after verifying its expected head SHA. Does not merge, review, comment, edit code, or change branch protection. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().positive().describe('Draft pull request number.'),
      expected_head_sha: z.string().min(7).describe('Current full head SHA read from this pull request immediately before this action.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number().optional(),
      already_ready: z.boolean().optional(),
      head_sha: z.string().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, number: input.pull_number },
          audit: { before: null, after: input },
          summary: `DRY RUN: would mark draft PR #${input.pull_number} ready for review in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const result = await prMarkReadyForReview({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        expectedHeadSha: input.expected_head_sha,
      });
      return {
        data: {
          executed: true,
          dry_run: false,
          number: result.number,
          already_ready: result.alreadyReady,
          head_sha: result.headSha,
          url: result.url,
        },
        audit: { before: { number: input.pull_number, expected_head_sha: input.expected_head_sha }, after: result },
        summary: result.alreadyReady
          ? `PR #${result.number} was already ready for review.`
          : `Marked PR #${result.number} ready for review without changing its code, reviews, or merge state.`,
      };
    },
  }, callerHash);
}
