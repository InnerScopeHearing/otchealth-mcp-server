import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { milestoneUpdate } from '../../github/full-client.js';

export function registerGitHubMilestoneUpdate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_milestone_update',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: update milestone',
      description: 'Update a milestone title, description, due date, or state. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      milestone_number: z.number().int().describe('Milestone number.'),
      title: z.string().optional().describe('New title.'),
      description: z.string().optional().describe('New description.'),
      due_on: z.string().optional().describe('New due date (ISO 8601).'),
      state: z.enum(['open', 'closed']).optional().describe('New state.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number().optional(),
      title: z.string().optional(),
      state: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, number: input.milestone_number },
          audit: { before: null, after: input },
          summary: `DRY RUN: would update milestone #${input.milestone_number} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await milestoneUpdate(input.owner, input.repo, input.milestone_number, { title: input.title, description: input.description, dueOn: input.due_on, state: input.state });
      return {
        data: { executed: true, dry_run: false, number: r.number, title: r.title, state: r.state },
        audit: { before: null, after: { number: r.number, state: r.state } },
        summary: `Updated milestone #${r.number} "${r.title}" in ${input.owner}/${input.repo} (${r.state})`,
      };
    },
  }, callerHash);
}
