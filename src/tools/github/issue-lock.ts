import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueLock } from '../../github/full-client.js';

export function registerGitHubIssueLock(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_lock',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: lock issue conversation',
      description: 'Lock an issue or PR conversation so only collaborators can comment. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issue_number: z.number().int().describe('Issue or pull request number.'),
      lock_reason: z.enum(['off-topic', 'too heated', 'resolved', 'spam']).optional().describe('Reason for locking.'),
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
          summary: `DRY RUN: would lock #${input.issue_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await issueLock(input.owner, input.repo, input.issue_number, input.lock_reason);
      return {
        data: { executed: true, dry_run: false, issue_number: input.issue_number },
        audit: { before: null, after: input },
        summary: `Locked #${input.issue_number} in ${input.owner}/${input.repo}${input.lock_reason ? ` (reason: ${input.lock_reason})` : ''}`,
      };
    },
  }, callerHash);
}
