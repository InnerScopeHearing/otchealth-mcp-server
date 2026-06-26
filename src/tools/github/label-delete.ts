import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { labelDelete } from '../../github/full-client.js';

export function registerGitHubLabelDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_label_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: delete label',
      description: 'Permanently delete a label from a repository. The label is also removed from all issues and PRs. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      label_name: z.string().describe('Label name to delete.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      label_name: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, label_name: input.label_name },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete label "${input.label_name}" from ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await labelDelete(input.owner, input.repo, input.label_name);
      return {
        data: { executed: true, dry_run: false, label_name: input.label_name },
        audit: { before: { name: input.label_name }, after: null },
        summary: `Deleted label "${input.label_name}" from ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
