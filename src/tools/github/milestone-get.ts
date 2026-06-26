import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { milestoneGet } from '../../github/full-client.js';

export function registerGitHubMilestoneGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_milestone_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get milestone',
      description: 'Retrieve a single milestone by number. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      milestone_number: z.number().int().describe('Milestone number.'),
    },
    outputShape: {
      number: z.number().optional(),
      title: z.string().optional(),
      state: z.string().optional(),
      due_on: z.string().nullable().optional(),
      open_issues: z.number().optional(),
      closed_issues: z.number().optional(),
    },
    handler: async (input) => {
      const m = await milestoneGet(input.owner, input.repo, input.milestone_number);
      return {
        data: { number: m.number, title: m.title, state: m.state, due_on: m.due_on, open_issues: m.open_issues, closed_issues: m.closed_issues },
        summary: `Milestone #${m.number}: "${m.title}" (${m.state}), ${m.open_issues} open / ${m.closed_issues} closed issues`,
      };
    },
  }, callerHash);
}
