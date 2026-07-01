import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createPullRequest } from '../../github/api-client.js';

/** github_create_pull_request — open a PR. CTO-gated + write-gated; honors dry_run. */
export function registerGitHubCreatePullRequest(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'github_create_pull_request',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: create pull request',
        description: 'Open a pull request from head into base via the App installation token. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        head: z.string().describe('Source branch.'),
        base: z.string().describe('Target branch (e.g. "main").'),
        body: z.string().optional(),
        draft: z.boolean().optional(),
      },
      outputShape: { number: z.number().optional(), url: z.string().optional(), state: z.string().optional(), planned: z.boolean().optional() },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return { data: { planned: true }, summary: `DRY RUN: would open PR "${input.title}" (${input.head} -> ${input.base}) in ${input.owner}/${input.repo}. Pass dry_run=false to execute.` };
        }
        const r = await createPullRequest(input.owner, input.repo, input.title, input.head, input.base, input.body, input.draft);
        return { data: r, summary: `Opened PR #${r.number} (${r.state}) in ${input.owner}/${input.repo}: ${r.url}`, audit: { after: r } };
      },
    },
    callerHash,
  );
}
