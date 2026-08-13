import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { assertRepoAllowed } from '../../github/api-client.js';
import { workflowRunGet } from '../../github/full-client.js';

export function registerGitHubWorkflowRunGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_run_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get workflow run',
      description: 'Get details for a single GitHub Actions workflow run by its numeric ID. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().describe('Workflow run numeric ID.'),
    },
    outputShape: {
      id: z.number().optional(),
      name: z.string().nullable().optional(),
      status: z.string().nullable().optional(),
      conclusion: z.string().nullable().optional(),
      workflow_id: z.number().optional(),
      head_branch: z.string().nullable().optional(),
      head_sha: z.string().optional(),
      run_started_at: z.string().nullable().optional(),
      url: z.string().optional(),
    },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const r = await workflowRunGet(input.owner, input.repo, input.run_id);
      return {
        data: {
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          workflow_id: r.workflow_id,
          head_branch: r.head_branch,
          head_sha: r.head_sha,
          run_started_at: r.run_started_at,
          url: r.html_url,
        },
        summary: `Run #${r.id} "${r.name}" on ${r.head_branch}: ${r.status}${r.conclusion ? ` / ${r.conclusion}` : ''}`,
      };
    },
  }, callerHash);
}
