import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prUpdateBranch } from '../../github/full-client.js';

export function registerGitHubPrUpdateBranch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_update_branch',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update PR branch (merge base into head)',
      description: 'Update the PR head branch with the latest changes from the base branch (equivalent to "Update branch" button in GitHub UI). Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
      expected_head_sha: z.string().optional().describe('Expected SHA of the PR head branch; used to detect races.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      message: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update branch for PR #${input.pull_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await prUpdateBranch(input.owner, input.repo, input.pull_number, input.expected_head_sha);
      return {
        data: { executed: true, dry_run: false, message: r.message },
        audit: { before: null, after: r },
        summary: `Updated branch for PR #${input.pull_number}: ${r.message}`,
      };
    },
  }, callerHash);
}
