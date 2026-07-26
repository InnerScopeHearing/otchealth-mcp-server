import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { branchGetProtection } from '../../github/full-client.js';

export function registerGitHubBranchGetProtection(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_branch_get_protection',
    category: 'read',
    annotations: {
      title: 'GitHub: get branch protection rules',
      description: 'Get the branch protection settings for a protected branch (required reviews, status checks, etc.). Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      branch: z.string().describe('Protected branch name.'),
    },
    outputShape: {
      protection: z.unknown(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const p = await branchGetProtection(input.owner, input.repo, input.branch);
      return {
        data: { protection: p },
        summary: `Branch protection for "${input.branch}" in ${input.owner}/${input.repo} retrieved.`,
      };
    },
  }, callerHash);
}
