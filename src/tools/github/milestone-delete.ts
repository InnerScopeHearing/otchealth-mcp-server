import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { milestoneDelete } from '../../github/full-client.js';

export function registerGitHubMilestoneDelete(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_milestone_delete',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: delete milestone',
      description: 'Permanently delete a milestone. Issues/PRs in the milestone are not deleted but become un-milestoned. Irreversible. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      milestone_number: z.number().int().describe('Milestone number.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      milestone_number: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, milestone_number: input.milestone_number },
          audit: { before: null, after: input },
          summary: `DRY RUN: would delete milestone #${input.milestone_number} from ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await milestoneDelete(input.owner, input.repo, input.milestone_number);
      return {
        data: { executed: true, dry_run: false, milestone_number: input.milestone_number },
        audit: { before: { milestone_number: input.milestone_number }, after: null },
        summary: `Deleted milestone #${input.milestone_number} from ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
