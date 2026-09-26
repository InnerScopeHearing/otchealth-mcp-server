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
    url: typeof raw?.html_url === 'string' ? raw.html_url : undefined,
  };
}

export function registerGitHubPrMarkReady(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_mark_ready',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: mark draft PR ready for review',
      description: 'CTO-only. Marks one open draft pull request ready for review through GitHub’s fixed GraphQL mutation. Defaults to dry run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Open draft pull request number.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number(),
      state: z.string(),
      draft: z.boolean(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const result = await markDraftPullRequestReady({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        dryRun: ctx.dryRun,
      }, {
        read: async () => snapshot(await getPullRequest(input.owner, input.repo, input.pull_number)),
        mutate: async (nodeId) => markPullRequestReadyForReview(nodeId),
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
