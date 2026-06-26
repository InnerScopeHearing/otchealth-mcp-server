import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowGet } from '../../github/full-client.js';

export function registerGitHubWorkflowGet(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_get',
    category: 'read',
    annotations: {
      title: 'GitHub: get workflow',
      description: 'Get details for a single GitHub Actions workflow by ID or filename. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      workflow_id: z.string().describe('Workflow file name (e.g. "ci.yml") or numeric workflow ID.'),
    },
    outputShape: {
      id: z.number().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      state: z.string().optional(),
    },
    handler: async (input) => {
      const w = await workflowGet(input.owner, input.repo, input.workflow_id);
      return {
        data: { id: w.id, name: w.name, path: w.path, state: w.state },
        summary: `Workflow "${w.name}" (${w.path}): ${w.state}`,
      };
    },
  }, callerHash);
}
