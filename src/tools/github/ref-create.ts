import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { refCreate } from '../../github/full-client.js';

export function registerGitHubRefCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_ref_create',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: create git ref',
      description: 'Create a new git ref (e.g. refs/heads/my-branch or refs/tags/v1.0.0) pointing to a commit SHA. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      ref: z.string().describe('Full ref name, e.g. "refs/heads/feature-x" or "refs/tags/v2.0.0".'),
      sha: z.string().describe('The SHA the ref should point to.'),
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
          summary: `DRY RUN: would create ref "${input.ref}" → ${input.sha} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await refCreate(input.owner, input.repo, input.ref, input.sha);
      return {
        data: { executed: true, dry_run: false, ref: r.ref, sha: r.object?.sha },
        audit: { before: null, after: { ref: r.ref, sha: r.object?.sha } },
        summary: `Created ref "${r.ref}" → ${r.object?.sha?.slice(0, 7)} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
