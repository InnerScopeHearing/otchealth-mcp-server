import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { refUpdate } from '../../github/full-client.js';

export function registerGitHubRefUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_ref_update',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update git ref',
      description: 'Update an existing git ref to point to a new SHA (fast-forward or force). Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      ref: z.string().describe('Ref path (without "refs/"), e.g. "heads/main" or "tags/v1.0.0".'),
      sha: z.string().describe('New SHA the ref should point to.'),
      force: z.boolean().optional().describe('Force update even if not a fast-forward (default false).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      ref: z.string().optional(),
      sha: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, ref: input.ref, sha: input.sha },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update ref "${input.ref}" → ${input.sha} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await refUpdate(input.owner, input.repo, input.ref, input.sha, input.force ?? false);
      return {
        data: { executed: true, dry_run: false, ref: r.ref, sha: r.object?.sha },
        audit: { before: null, after: { ref: r.ref, sha: r.object?.sha } },
        summary: `Updated ref "${r.ref}" → ${r.object?.sha?.slice(0, 7)} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
