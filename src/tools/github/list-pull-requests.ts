import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listPullRequests, assertRepoAllowed } from '../../github/api-client.js';

export function registerGitHubListPullRequests(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_list_pull_requests', category: 'read',
    annotations: { title: 'List GitHub pull requests', description: 'List pull requests for a GitHub repository. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { owner: z.string().describe('Repository owner (user or org), e.g. "octocat".'), repo: z.string().describe('Repository name, e.g. "hello-world".'), state: z.string().optional().describe('PR state filter: "open" (default), "closed", or "all".') },
    outputShape: { prs: z.array(z.unknown()), count: z.number() },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const prs = await listPullRequests(input.owner, input.repo, input.state ?? 'open');
      return {
        data: {
          prs: prs.map((pr: any) => ({ number: pr.number, title: pr.title, state: pr.state, user: pr.user?.login, draft: pr.draft, url: pr.html_url })),
          count: prs.length,
        },
        summary: `${prs.length} PR(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
