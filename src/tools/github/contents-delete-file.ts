import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { contentsDeleteFile } from '../../github/full-client.js';

export function registerGitHubContentsDeleteFile(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_contents_delete_file',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: delete file from repo',
      description: 'Delete a file from a repository branch via the Contents API. Requires the blob SHA. Irreversible without a new commit. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      path: z.string().describe('File path within the repo (e.g. "src/index.ts").'),
      message: z.string().describe('Commit message for the deletion.'),
      sha: z.string().describe('Blob SHA of the file to delete (get via github_get_file_contents).'),
      branch: z.string().optional().describe('Branch to delete from (default: repo default branch).'),
      author_name: z.string().optional().describe('Commit author name.'),
      author_email: z.string().optional().describe('Commit author email.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      commit: z.string().optional(),
      path: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, path: input.path },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete "${input.path}" from ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await contentsDeleteFile({
        owner: input.owner,
        repo: input.repo,
        path: input.path,
        message: input.message,
        sha: input.sha,
        branch: input.branch,
        author: input.author_name && input.author_email ? { name: input.author_name, email: input.author_email } : undefined,
      });
      return {
        data: { executed: true, dry_run: false, commit: r.commit, path: r.path },
        audit: { before: { sha: input.sha }, after: null },
        summary: `Deleted "${r.path}" from ${input.owner}/${input.repo} (commit ${r.commit.slice(0, 7)})`,
      };
    },
  }, callerHash);
}
