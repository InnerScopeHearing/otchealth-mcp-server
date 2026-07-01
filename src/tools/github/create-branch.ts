import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { createBranch } from '../../github/write-client.js';

/** github_create_branch — create a new branch. CTO-gated + write-gated; honors dry_run. */
export function registerGitHubCreateBranch(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'github_create_branch',
      category: 'write_simple',
      annotations: {
        title: 'GitHub: create branch',
        description:
          'Create a new branch in a repository via the App installation token. Defaults to branching from the repo default-branch HEAD; pass from_sha to pin to a specific commit. CTO-only; honors dry_run.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation, e.g. "InnerScopeHearing".'),
        repo: z.string().describe('Repository name.'),
        branch: z.string().describe('Name of the new branch to create.'),
        from_sha: z
          .string()
          .optional()
          .describe('Full commit SHA to branch from. Omit to use the default branch HEAD.'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        branch: z.string(),
        sha: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, branch: input.branch },
            audit: { before: null, after: input },
            summary: `DRY RUN: would create branch "${input.branch}" in ${input.owner}/${input.repo}. Pass dry_run=false to execute.`,
          };
        }
        const r = await createBranch(input.owner, input.repo, input.branch, input.from_sha);
        return {
          data: { executed: true, dry_run: false, branch: r.branch, sha: r.sha },
          audit: { before: null, after: r },
          summary: `Created branch "${r.branch}" at ${r.sha.slice(0, 12)} in ${input.owner}/${input.repo}.`,
        };
      },
    },
    callerHash,
  );
}
