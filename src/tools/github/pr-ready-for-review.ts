import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prGet, prUpdate } from '../../github/full-client.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { markDraftReadyForReview, type ReadyPullRequest } from '../../github/pr-ready-core.js';

function snapshot(raw: any): ReadyPullRequest {
  return {
    number: Number(raw.number),
    state: String(raw.state ?? ''),
    draft: raw.draft === true,
    merged: raw.merged === true,
    headSha: String(raw.head?.sha ?? ''),
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : undefined,
  };
}

export function registerGitHubPrReadyForReview(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_ready_for_review',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: mark draft PR ready for review',
      description: 'CTO-gated, dry-run-by-default admission of an existing draft PR after expected-head verification. Cannot merge, approve, or change branches.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Open draft pull request number.'),
      expected_head_sha: z.string().describe('Exact 40-character SHA expected at the PR head.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number(),
      state: z.string(),
      draft: z.boolean(),
      head_sha: z.string(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const result = await markDraftReadyForReview({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        expectedHeadSha: input.expected_head_sha,
        dryRun: ctx.dryRun,
      }, {
        read: async () => snapshot(await prGet(input.owner, input.repo, input.pull_number)),
        update: async () => snapshot(await prUpdate({ owner: input.owner, repo: input.repo, pullNumber: input.pull_number, draft: false })),
      });
      return {
        data: result,
        audit: { before: null, after: result },
        summary: result.executed
          ? `Marked PR #${result.number} ready for review in ${input.owner}/${input.repo}.`
          : `DRY RUN: PR #${result.number} passed ready-for-review admission in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
      };
    },
  }, callerHash);
}
