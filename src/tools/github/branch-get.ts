import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { branchGet } from '../../github/full-client.js';

export function registerGitHubBranchGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_branch_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get branch',
      description: 'Get metadata for a single branch including HEAD commit SHA and protection status. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      branch: z.string().describe('Branch name.'),
    },
    outputShape: {
      name: z.string().optional(),
      sha: z.string().optional(),
      protected: z.boolean().optional(),
    },
    handler: async (input) => {
      const b = await branchGet(input.owner, input.repo, input.branch);
      return {
        data: { name: b.name, sha: b.commit?.sha, protected: b.protected },
        summary: `Branch "${b.name}" → ${b.commit?.sha?.slice(0, 7)}, protected: ${b.protected}`,
      };
    },
  }, callerHash);
}
