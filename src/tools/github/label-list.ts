import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { labelList } from '../../github/full-client.js';

export function registerGitHubLabelList(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_label_list',
    category: 'read',
    annotations: {
      title: 'GitHub: list labels',
      description: 'List all labels defined in a repository. Read-only.',
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
      labels: z.array(z.unknown()),
      count: z.number(),
    },
    handler: async (input) => {
      const labels = await labelList(input.owner, input.repo, input.per_page ?? 30, input.page ?? 1);
      return {
        data: {
          labels: labels.map((l: any) => ({ name: l.name, color: l.color, description: l.description })),
          count: labels.length,
        },
        summary: `${labels.length} label(s) in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
