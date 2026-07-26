import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { commitGet } from '../../github/full-client.js';

export function registerGitHubCommitGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_commit_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get commit',
      description: 'Get detailed information about a single commit including changed files and stats. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      ref: z.string().describe('Commit SHA, branch, or tag.'),
    },
    outputShape: {
      sha: z.string().optional(),
      message: z.string().optional(),
      author: z.string().optional(),
      date: z.string().optional(),
      url: z.string().optional(),
      stats: z.unknown().optional(),
      files: z.array(z.unknown()).optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const c = await commitGet(input.owner, input.repo, input.ref);
      return {
        data: {
          sha: c.sha,
          message: c.commit?.message,
          author: c.commit?.author?.name,
          date: c.commit?.author?.date,
          url: c.html_url,
          stats: c.stats,
          files: (c.files ?? []).map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
        },
        summary: `Commit ${c.sha?.slice(0, 7)}: ${c.commit?.message?.split('\n')[0]}`,
      };
    },
  }, callerHash);
}
