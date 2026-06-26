import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueAddAssignees } from '../../github/full-client.js';

export function registerGitHubIssueAddAssignees(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_add_assignees',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: add assignees to issue',
      description: 'Add one or more assignees to an issue or pull request. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issue_number: z.number().int().describe('Issue or pull request number.'),
      assignees: z.array(z.string()).min(1).describe('GitHub usernames to add as assignees.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      assignees: z.array(z.string()).optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, assignees: input.assignees },
          audit: { before: null, after: input },
          summary: `DRY RUN: would add assignees [${input.assignees.join(', ')}] to #${input.issue_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await issueAddAssignees(input.owner, input.repo, input.issue_number, input.assignees);
      const assignees = (r.assignees ?? []).map((a: any) => a.login);
      return {
        data: { executed: true, dry_run: false, assignees },
        audit: { before: null, after: { assignees } },
        summary: `Added assignees [${input.assignees.join(', ')}] to #${input.issue_number} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
