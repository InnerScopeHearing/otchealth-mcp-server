import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { refDelete } from '../../github/full-client.js';

export function registerGitHubRefDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_ref_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: delete git ref',
      description: 'Delete a git ref (e.g. delete a branch or lightweight tag). Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      ref: z.string().describe('Ref path (without "refs/"), e.g. "heads/old-branch" or "tags/v0.9.0".'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      ref: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, ref: input.ref },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete ref "${input.ref}" in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await refDelete(input.owner, input.repo, input.ref);
      return {
        data: { executed: true, dry_run: false, ref: input.ref },
        audit: { before: { ref: input.ref }, after: null },
        summary: `Deleted ref "${input.ref}" from ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
