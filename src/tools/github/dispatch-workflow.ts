import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { dispatchWorkflow } from '../../github/write-client.js';

/**
 * github_dispatch_workflow — fire a workflow_dispatch event on a GitHub Actions workflow.
 * write_orchestrated (triggers builds / deploys). CTO-gated; honors dry_run.
 */
export function registerGitHubDispatchWorkflow(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'github_dispatch_workflow',
      category: 'write_orchestrated',
      annotations: {
        title: 'GitHub: dispatch workflow (workflow_dispatch)',
        description:
          'Trigger a workflow_dispatch event for a GitHub Actions workflow identified by its file name or numeric ID. The workflow must have `on: workflow_dispatch` in its YAML. Defaults to dry_run. CTO-only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        owner: z.string().describe('Repository owner or organisation.'),
        repo: z.string().describe('Repository name.'),
        workflow_id: z
          .string()
          .describe('Workflow file name (e.g. "ci.yml") or numeric workflow ID.'),
        ref: z.string().describe('Branch or tag to run the workflow against (e.g. "main").'),
        inputs: z
          .record(z.string())
          .optional()
          .describe('Workflow input key/value pairs (must match the workflow input schema).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        owner: z.string().optional(),
        repo: z.string().optional(),
        workflow: z.string().optional(),
        ref: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: {
              executed: false,
              dry_run: true,
              owner: input.owner,
              repo: input.repo,
              workflow: input.workflow_id,
              ref: input.ref,
            },
            audit: { before: null, after: input },
            summary: `DRY RUN: would dispatch workflow "${input.workflow_id}" on ${input.owner}/${input.repo}@${input.ref}. Pass dry_run=false to execute.`,
          };
        }
        const r = await dispatchWorkflow(
          input.owner,
          input.repo,
          input.workflow_id,
          input.ref,
          input.inputs,
        );
        return {
          data: {
            executed: true,
            dry_run: false,
            owner: r.owner,
            repo: r.repo,
            workflow: String(r.workflow),
            ref: r.ref,
          },
          audit: { before: null, after: r },
          summary: `Dispatched workflow "${r.workflow}" on ${r.owner}/${r.repo}@${r.ref}.`,
        };
      },
    },
    callerHash,
  );
}
