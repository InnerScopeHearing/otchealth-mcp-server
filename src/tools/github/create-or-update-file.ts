import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createOrUpdateFile } from '../../github/write-client.js';

/**
 * github_create_or_update_file — single-file commit via PUT /repos/{o}/{r}/contents/{path}.
 * CTO-gated + write-gated; honors dry_run.
 *
 * For multi-file commits use github_push_files instead.
 */
export function registerGitHubCreateOrUpdateFile(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'github_create_or_update_file',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: create or update a single file',
        description:
          'Create or update a single file in a repository using the Contents API (PUT /repos/{owner}/{repo}/contents/{path}). Provide sha to update an existing file; omit to create. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation.'),
        repo: z.string().describe('Repository name.'),
        path: z.string().describe('File path within the repo, e.g. "src/config.ts".'),
        message: z.string().describe('Commit message.'),
        content: z.string().describe('UTF-8 file content (will be base64-encoded for the API).'),
        branch: z.string().optional().describe('Target branch. Defaults to the repo default branch.'),
        sha: z
          .string()
          .optional()
          .describe('Existing file blob SHA — required when updating an existing file.'),
        author_name: z.string().optional().describe('Commit author display name.'),
        author_email: z.string().optional().describe('Commit author email.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        commit: z.string().optional(),
        path: z.string().optional(),
        operation: z.enum(['created', 'updated']).optional(),
      },
      handler: async (input, ctx) => {
        const operation = input.sha ? 'updated' : 'created';
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, path: input.path, operation },
            audit: { before: null, after: { path: input.path, branch: input.branch, sha: input.sha } },
            summary: `DRY RUN: would ${operation} "${input.path}" in ${input.owner}/${input.repo}. Pass dry_run=false to execute.`,
          };
        }
        const r = await createOrUpdateFile({
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          message: input.message,
          content: input.content,
          branch: input.branch,
          sha: input.sha,
          author:
            input.author_name && input.author_email
              ? { name: input.author_name, email: input.author_email }
              : undefined,
        });
        return {
          data: { executed: true, dry_run: false, commit: r.commit, path: r.path, operation: r.operation },
          audit: { before: null, after: r },
          summary: `${r.operation === 'created' ? 'Created' : 'Updated'} "${r.path}" in ${input.owner}/${input.repo} (commit ${r.commit.slice(0, 12)}).`,
        };
      },
    },
    callerHash,
  );
}
