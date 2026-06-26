import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { milestoneList } from '../../github/full-client.js';

export function registerGitHubMilestoneList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_milestone_list',
    category: 'read',
    annotations: {
      title: 'GitHub: list milestones',
      description: 'List milestones for a repository. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Milestone state filter (default: open).'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      milestones: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const ms = await milestoneList(input.owner, input.repo, input.state ?? 'open', input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          milestones: ms.map((m: any) => ({ number: m.number, title: m.title, state: m.state, due_on: m.due_on, open_issues: m.open_issues, closed_issues: m.closed_issues })),
          count: ms.length,
        },
        summary: `${ms.length} milestone(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
