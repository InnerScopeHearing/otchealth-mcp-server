import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { issueGet } from '../../github/full-client.js';

export function registerGitHubIssueGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_issue_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get issue',
      description: 'Retrieve full detail for a single GitHub issue. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      issue_number: z.number().int().describe('Issue number.'),
    },
    outputShape: {
      number: z.number().optional(),
      title: z.string().optional(),
      state: z.string().optional(),
      body: z.string().nullable().optional(),
      user: z.string().optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
      url: z.string().optional(),
      created_at: z.string().optional(),
    },
    handler: async (input) => {
      const i = await issueGet(input.owner, input.repo, input.issue_number);
      return {
        data: {
          number: i.number,
          title: i.title,
          state: i.state,
          body: i.body,
          user: i.user?.login,
          labels: (i.labels ?? []).map((l: any) => l.name),
          assignees: (i.assignees ?? []).map((a: any) => a.login),
          url: i.html_url,
          created_at: i.created_at,
        },
        summary: `Issue #${i.number}: ${i.title} (${i.state})`,
      };
    },
  }, callerHash);
}
