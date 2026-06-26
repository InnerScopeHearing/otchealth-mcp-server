import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueUnlock } from '../../github/full-client.js';

export function registerGitHubIssueUnlock(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_unlock',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: unlock issue conversation',
      description: 'Unlock a previously locked issue or PR conversation. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issue_number: z.number().int().describe('Issue or pull request number.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      issue_number: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, issue_number: input.issue_number },
          audit: { before: null, after: input },
          summary: `DRY RUN: would unlock #${input.issue_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await issueUnlock(input.owner, input.repo, input.issue_number);
      return {
        data: { executed: true, dry_run: false, issue_number: input.issue_number },
        audit: { before: null, after: input },
        summary: `Unlocked #${input.issue_number} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
