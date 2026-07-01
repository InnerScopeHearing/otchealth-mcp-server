import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowRunListArtifacts } from '../../github/full-client.js';

export function registerGitHubWorkflowRunListArtifacts(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_run_list_artifacts',
    category: 'read',
    annotations: {
      title: 'GitHub: list workflow run artifacts',
      description: 'List artifacts uploaded by a specific workflow run. Read-only.',
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
      artifacts: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const artifacts = await workflowRunListArtifacts(input.owner, input.repo, input.run_id);
      return {
        data: {
          artifacts: artifacts.map((a: any) => ({ id: a.id, name: a.name, size_in_bytes: a.size_in_bytes, expired: a.expired, created_at: a.created_at, expires_at: a.expires_at })),
          count: artifacts.length,
        },
        summary: `${artifacts.length} artifact(s) from run #${input.run_id}`,
      };
    },
  }, callerHash);
}
