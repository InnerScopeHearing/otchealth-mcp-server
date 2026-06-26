import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { workflowRunRerun } from '../../github/full-client.js';

export function registerGitHubWorkflowRunRerun(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_workflow_run_rerun',
    category: 'write_orchestrated',
    annotations: {
      title: 'GitHub: re-run workflow run',
      description: 'Re-run a failed or completed GitHub Actions workflow run (all jobs). This triggers a new build. Defaults to dry_run.',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputShape: {
      owner: z.string().describe('Repository owner.'),
      repo: z.string().describe('Repository name.'),
      run_id: z.number().int().describe('Workflow run numeric ID to re-run.'),
      enable_debug_logging: z.boolean().optional().describe('Enable debug logging for the re-run (default false).'),
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
          summary: `DRY RUN: would re-run workflow run #${input.run_id} in ${input.owner}/${input.repo}. Pass dry_run=false to apply.`,
        };
      }
      await workflowRunRerun(input.owner, input.repo, input.run_id, input.enable_debug_logging ?? false);
      return {
        data: { executed: true, dry_run: false, run_id: input.run_id },
        audit: { before: null, after: { run_id: input.run_id, action: 'rerun' } },
        summary: `Re-run triggered for workflow run #${input.run_id} in ${input.owner}/${input.repo}`,
      };
    },
  }, callerHash);
}
