import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueUpdate } from '../../github/full-client.js';

export function registerGitHubIssueUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_update',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update / close issue',
      description: 'Update an issue title, body, state (close/reopen), labels, assignees, or milestone. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issue_number: z.number().int().describe('Issue number.'),
      title: z.string().optional().describe('New title.'),
      body: z.string().optional().describe('New body (Markdown).'),
      state: z.enum(['open', 'closed']).optional().describe('New state.'),
      state_reason: z.enum(['completed', 'not_planned', 'reopened']).optional().describe('Reason for state change.'),
      labels: z.array(z.string()).optional().describe('Replace label set with these labels.'),
      assignees: z.array(z.string()).optional().describe('Replace assignee set with these usernames.'),
      milestone: z.number().int().nullable().optional().describe('Milestone number (null to unset).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number().optional(),
      state: z.string().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, number: input.issue_number },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update issue #${input.issue_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await issueUpdate({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.issue_number,
        title: input.title,
        body: input.body,
        state: input.state,
        stateReason: input.state_reason,
        labels: input.labels,
        assignees: input.assignees,
        milestone: input.milestone,
      });
      return {
        data: { executed: true, dry_run: false, number: r.number, state: r.state, url: r.html_url },
        audit: { before: null, after: { number: r.number, state: r.state } },
        summary: `Updated issue #${r.number} in ${input.owner}/${input.repo} (state: ${r.state})`,
      };
    },
  }, callerHash);
}
