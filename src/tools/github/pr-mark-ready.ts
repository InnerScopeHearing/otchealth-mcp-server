import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed, getPullRequest, markPullRequestReadyForReview } from '../../github/api-client.js';
import { markDraftPullRequestReady, type PullRequestSnapshot } from '../../github/pr-mark-ready-core.js';

function snapshot(raw: any): PullRequestSnapshot {
  return {
    number: Number(raw?.number),
    state: String(raw?.state ?? ''),
    draft: raw?.draft === true,
    merged: raw?.merged === true,
    nodeId: typeof raw?.node_id === 'string' ? raw.node_id : '',
    headSha: typeof raw?.head?.sha === 'string' ? raw.head.sha : '',
    url: typeof raw?.html_url === 'string' ? raw.html_url : undefined,
  };
}

export function registerGitHubPrMarkReady(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_mark_ready',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: mark draft PR ready for review',
      description: 'CTO-only. Limited to InnerScopeHearing/otchealth-cto PR #712 and requires its full current head SHA. Defaults to dry run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('The allowed reviewed cost and usage pull request number.'),
      expected_head_sha: z.string().regex(/^[0-9a-f]{40}$/i).describe('Full 40-character expected head SHA.'),
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
      const result = await markDraftPullRequestReady({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        expectedHeadSha: input.expected_head_sha,
        dryRun: ctx.dryRun,
      }, {
        read: async () => snapshot(await getPullRequest(input.owner, input.repo, input.pull_number)),
        mutate: async (nodeId, expectedNumber, expectedHeadSha, expectedRepositoryFullName) =>
          markPullRequestReadyForReview(nodeId, expectedNumber, expectedHeadSha, expectedRepositoryFullName),
      });
      return {
        data: result,
        audit: { before: null, after: result },
        summary: result.executed
          ? `Marked PR #${result.number} ready for review in ${input.owner}/${input.repo} at ${result.head_sha}.`
          : `DRY RUN: PR #${result.number} passed ready-for-review admission in ${input.owner}/${input.repo} at ${result.head_sha}. Pass dry_run=false to apply.`,
      };
    },
  }, callerHash);
}
