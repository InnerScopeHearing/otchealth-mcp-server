import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { mergePullRequest } from '../../github/api-client.js';

/** github_merge_pull_request — merge a PR. CTO-gated + write-gated; honors dry_run. */
export function registerGitHubMergePullRequest(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'github_merge_pull_request',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: merge pull request',
        description: 'Merge a pull request (squash/merge/rebase) via the App installation token. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string(),
        repo: z.string(),
        number: z.number().int().describe('PR number.'),
        method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (default squash).'),
        title: z.string().optional().describe('Optional merge commit title.'),
      },
      outputShape: { merged: z.boolean().optional(), sha: z.string().optional(), message: z.string().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return { data: { planned: true }, summary: `DRY RUN: would ${input.method ?? 'squash'}-merge PR #${input.number} in ${input.owner}/${input.repo}. Pass dry_run=false to execute.` };
        }
        const r = await mergePullRequest(input.owner, input.repo, input.number, input.method ?? 'squash', input.title);
        return { data: r, summary: `PR #${input.number} merge: merged=${r.merged} ${r.sha ? '(' + r.sha.slice(0, 12) + ')' : ''} ${r.message}`, audit: { after: r } };
      },
    },
    callerHash,
  );
}
