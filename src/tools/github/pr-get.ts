import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { prGet } from '../../github/full-client.js';
import { assertRepoAllowed } from '../../github/api-client.js';

export function registerGitHubPrGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get pull request',
      description: 'Retrieve full metadata for a single pull request including head/base branches, merge state, and review status. Read-only.',
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
      number: z.number().optional(),
      title: z.string().optional(),
      state: z.string().optional(),
      draft: z.boolean().optional(),
      merged: z.boolean().optional(),
      mergeable: z.boolean().nullable().optional(),
      head: z.string().optional(),
      base: z.string().optional(),
      url: z.string().optional(),
      user: z.string().optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const pr = await prGet(input.owner, input.repo, input.pull_number);
      return {
        data: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          merged: pr.merged,
          mergeable: pr.mergeable,
          head: pr.head?.ref,
          base: pr.base?.ref,
          url: pr.html_url,
          user: pr.user?.login,
        },
        summary: `PR #${pr.number}: ${pr.title} (${pr.state}${pr.draft ? ', draft' : ''})`,
      };
    },
  }, callerHash);
}
