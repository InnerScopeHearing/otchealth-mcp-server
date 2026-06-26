import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowRunCancel } from '../../github/full-client.js';

export function registerGitHubWorkflowRunCancel(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_run_cancel',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: cancel workflow run',
      description: 'Cancel an in-progress GitHub Actions workflow run. This is a build-affecting action. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().describe('Workflow run numeric ID to cancel.'),
    },
    outputShape: {
      executed: z.boolean(),
      dry_run: z.boolean(),
      run_id: z.number().optional(),
    },
    handler: async (input, ctx) => {
      if (ctx.dryRun) {
        return {
          data: { executed: false, dry_run: true, run_id: input.run_id },
          audit: { before: null, after: input },
          summary: `DRY RUN: would cancel workflow run #${input.run_id} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await workflowRunCancel(input.owner, input.repo, input.run_id);
      return {
        data: { executed: true, dry_run: false, run_id: input.run_id },
        audit: { before: null, after: { run_id: input.run_id, action: 'cancelled' } },
        summary: `Cancelled workflow run #${input.run_id} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
