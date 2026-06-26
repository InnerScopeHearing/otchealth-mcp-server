import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowEnable } from '../../github/full-client.js';

export function registerGitHubWorkflowEnable(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_enable',
    category: 'write_simple',
    annotations: {
      title: 'GitHub: enable workflow',
      description: 'Enable a disabled GitHub Actions workflow so it can be triggered. Defaults to dry_run.',
      readOnlyHint: false,
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
      executed: z.boolean(),
      dry_run: z.boolean(),
      workflow_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, workflow_id: input.workflow_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would enable workflow "${input.workflow_id}" in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await workflowEnable(input.owner, input.repo, input.workflow_id);
      return {
        data: { executed: true, dry_run: false, workflow_id: input.workflow_id },
        audit: { before: null, after: { workflow_id: input.workflow_id, state: 'active' } },
        summary: `Enabled workflow "${input.workflow_id}" in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
