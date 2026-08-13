import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { prListFiles } from '../../github/full-client.js';

export function registerGitHubPrListFiles(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_pr_list_files',
    category: 'read',
    annotations: {
      title: 'GitHub: list pull request files',
      description: 'List files changed in a pull request with patch stats. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      pull_number: z.number().int().describe('Pull request number.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      files: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const files = await prListFiles(input.owner, input.repo, input.pull_number, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          files: files.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })),
          count: files.length,
        },
        summary: `${files.length} file(s) changed in PR #${input.pull_number}`,
      };
    },
  }, callerHash);
}
