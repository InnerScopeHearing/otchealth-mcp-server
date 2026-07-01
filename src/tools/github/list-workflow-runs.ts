import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listWorkflowRuns } from '../../github/api-client.js';

export function registerGitHubListWorkflowRuns(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_list_workflow_runs', category: 'read',
    annotations: { title: 'List GitHub workflow runs', description: 'List recent Actions workflow runs for a GitHub repository. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { owner: z.string().describe('Repository owner (user or org), e.g. "octocat".'), repo: z.string().describe('Repository name, e.g. "hello-world".') },
    outputShape: { runs: z.array(z.unknown()), count: z.number() },
    handler: async (input) => {
      const runs = await listWorkflowRuns(input.owner, input.repo);
      return {
        data: {
          runs: runs.map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, head_branch: r.head_branch, created_at: r.created_at })),
          count: runs.length,
        },
        summary: `${runs.length} workflow run(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
