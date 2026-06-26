import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { milestoneCreate } from '../../github/full-client.js';

export function registerGitHubMilestoneCreate(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_milestone_create',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: create milestone',
      description: 'Create a new milestone in a repository. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      title: z.string().describe('Milestone title.'),
      description: z.string().optional().describe('Milestone description.'),
      due_on: z.string().optional().describe('Due date in ISO 8601 format, e.g. "2025-12-31T00:00:00Z".'),
      state: z.enum(['open', 'closed']).optional().describe('Initial state (default: open).'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      number: z.number().optional(),
      title: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, title: input.title },
          audit: { before: null, after: input },
          summary: `DRY RUN: would create milestone "${input.title}" in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      const r = await milestoneCreate(input.owner, input.repo, input.title, { description: input.description, dueOn: input.due_on, state: input.state });
      return {
        data: { executed: true, dry_run: false, number: r.number, title: r.title },
        audit: { before: null, after: { number: r.number, title: r.title } },
        summary: `Created milestone #${r.number} "${r.title}" in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
