import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { commitCompare } from '../../github/full-client.js';

export function registerGitHubCommitCompare(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_commit_compare',
    category: 'read',
    annotations: {
      title: 'GitHub: compare commits / branches',
      description: 'Compare two commits, branches, or tags and return ahead/behind counts, diff stats, and changed files. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      base: z.string().describe('Base branch, tag, or commit SHA.'),
      head: z.string().describe('Head branch, tag, or commit SHA.'),
    },
    outputShape: {
      status: z.string().optional(),
      ahead_by: z.number().optional(),
      behind_by: z.number().optional(),
      total_commits: z.number().optional(),
      files: z.array(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const r = await commitCompare(input.owner, input.repo, input.base, input.head);
      return {
        data: {
          status: r.status,
          ahead_by: r.ahead_by,
          behind_by: r.behind_by,
          total_commits: r.total_commits,
          files: (r.files ?? []).map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
        },
        summary: `${input.base}...${input.head}: ${r.status}, +${r.ahead_by} / -${r.behind_by} commits, ${(r.files ?? []).length} file(s) changed`,
      };
    },
  }, callerHash);
}
