import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowList } from '../../github/full-client.js';

export function registerGitHubWorkflowList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_list',
    category: 'read',
    annotations: {
      title: 'GitHub: list workflows',
      description: 'List GitHub Actions workflows defined in a repository. Read-only.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page (default 30).'),
      page: z.number().int().min(1).optional().describe('Page number (default 1).'),
    },
    outputShape: {
      workflows: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const workflows = await workflowList(input.owner, input.repo, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          workflows: workflows.map((w: any) => ({ id: w.id, name: w.name, path: w.path, state: w.state })),
          count: workflows.length,
        },
        summary: `${workflows.length} workflow(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
