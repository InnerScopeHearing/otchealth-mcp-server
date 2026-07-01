import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { releaseDelete } from '../../github/full-client.js';

export function registerGitHubReleaseDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_release_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: delete release',
      description: 'Permanently delete a release (does NOT delete the associated git tag). Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      release_id: z.number().int().describe('Release numeric ID.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      release_id: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, release_id: input.release_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete release ${input.release_id} from ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await releaseDelete(input.owner, input.repo, input.release_id);
      return {
        data: { executed: true, dry_run: false, release_id: input.release_id },
        audit: { before: { release_id: input.release_id }, after: null },
        summary: `Deleted release ${input.release_id} from ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
