import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prUpdate } from '../../github/full-client.js';

export function registerGitHubPrUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_update',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update pull request',
      description: 'Update a pull request title, body, state (open/closed), or base branch. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
      title: z.string().optional().describe('New title.'),
      body: z.string().optional().describe('New body (Markdown).'),
      state: z.enum(['open', 'closed']).optional().describe('Set state to open or closed.'),
      base: z.string().optional().describe('New base branch name.'),
      maintainer_can_modify: z.boolean().optional().describe('Allow maintainers to modify the PR head branch.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number().optional(),
      state: z.string().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, number: input.pull_number },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update PR #${input.pull_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await prUpdate({
        owner: input.owner,
        repo: input.repo,
        pullNumber: input.pull_number,
        title: input.title,
        body: input.body,
        state: input.state,
        base: input.base,
        maintainerCanModify: input.maintainer_can_modify,
      });
      return {
        data: { executed: true, dry_run: false, number: r.number, state: r.state, url: r.html_url },
        audit: { before: null, after: { number: r.number, state: r.state } },
        summary: `Updated PR #${r.number} in ${input.owner}/${input.repo} (state: ${r.state})`,
      };
    },
  }, callerHash);
}
