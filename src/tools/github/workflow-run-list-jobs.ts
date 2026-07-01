import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowRunListJobs } from '../../github/full-client.js';

export function registerGitHubWorkflowRunListJobs(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_run_list_jobs',
    category: 'read',
    annotations: {
      title: 'GitHub: list workflow run jobs',
      description: 'List all jobs for a specific workflow run with their step-level status. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().describe('Workflow run numeric ID.'),
      filter: z.enum(['latest', 'all']).optional().describe('Return latest attempt jobs (default) or all attempts.'),
    },
    outputShape: {
      jobs: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const jobs = await workflowRunListJobs(input.owner, input.repo, input.run_id, input.filter ?? 'latest');
      return {
        data: {
          jobs: jobs.map((j: any) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion,
            started_at: j.started_at,
            completed_at: j.completed_at,
            steps: (j.steps ?? []).map((s: any) => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number })),
          })),
          count: jobs.length,
        },
        summary: `${jobs.length} job(s) in run #${input.run_id}`,
      };
    },
  }, callerHash);
}
