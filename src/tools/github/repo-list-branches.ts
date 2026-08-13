import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { repoListBranches } from '../../github/full-client.js';

export function registerGitHubRepoListBranches(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_repo_list_branches',
    category: 'read',
    annotations: {
      title: 'GitHub: list branches',
      description: 'List branches for a repository. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      branches: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const branches = await repoListBranches(input.owner, input.repo, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          branches: branches.map((b: any) => ({ name: b.name, sha: b.commit?.sha, protected: b.protected })),
          count: branches.length,
        },
        summary: `${branches.length} branch(es) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
