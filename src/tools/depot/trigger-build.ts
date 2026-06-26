import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { triggerRun, dispatchWorkflow } from '../../depot/write-client.js';

/**
 * depot_trigger_build — trigger a Depot CI build via the native Depot CI API.
 *
 * Implementation note: Depot has a native REST/Connect API (GA June 2026) with two
 * relevant methods:
 *
 *   POST /depot.ci.v1.CIService/Run
 *     Trigger a full CI run (all workflows, or scoped to one workflow/job).
 *     Use this for normal CI runs (push-style).
 *
 *   POST /depot.ci.v1.CIService/DispatchWorkflow
 *     Dispatch a single workflow that declares `on: workflow_dispatch`.
 *     Use this for manual / conditional builds (deploy, release, etc.).
 *
 * `mode` selects which path to use. Defaults to "run".
 *
 * If this fleet still has iOS/CI workflows only on GitHub Actions (not yet migrated
 * to .depot/workflows/), use github_dispatch_workflow instead.
 *
 * write_orchestrated (triggers compute + build minutes). CTO-gated; honors dry_run.
 */
export function registerDepotTriggerBuild(
  server: McpServer,
  callerHash: CallerHashProvider,
): void {
  registerTool(
    server,
    {
      name: 'depot_trigger_build',
      category: 'write_orchestrated',
      annotations: {
        title: 'Depot: trigger CI build',
        description:
          'Trigger a Depot CI build via the native Depot CI API (CIService/Run or CIService/DispatchWorkflow). Use mode="run" for a standard CI run; use mode="dispatch" for workflow_dispatch-triggered workflows. Defaults to dry_run. CTO-only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        repo: z
          .string()
          .describe('GitHub repository in "owner/name" format, e.g. "InnerScopeHearing/otchealth-ios".'),
        mode: z
          .enum(['run', 'dispatch'])
          .default('run')
          .describe(
            '"run" triggers a full CI run (CIService/Run). "dispatch" fires a workflow_dispatch event (CIService/DispatchWorkflow) — requires workflow and ref.',
          ),
        workflow: z
          .string()
          .optional()
          .describe(
            'For mode="run": path relative to repo root, e.g. ".depot/workflows/ci.yml". For mode="dispatch": basename only, e.g. "deploy.yml".',
          ),
        ref: z
          .string()
          .optional()
          .describe('Branch or tag to run against. Required for mode="dispatch". Defaults to the repo default branch for mode="run".'),
        sha: z
          .string()
          .optional()
          .describe('Full 40-character commit SHA (mode="run" only). Defaults to HEAD of the default branch.'),
        job: z
          .string()
          .optional()
          .describe('Single job key to run within the workflow (mode="run" only).'),
        inputs: z
          .record(z.string())
          .optional()
          .describe('Workflow dispatch inputs — key/value pairs validated against the workflow input schema (mode="dispatch" only).'),
      },
      outputShape: {
        executed: z.boolean(),
        dry_run: z.boolean(),
        run_id: z.string().optional(),
        org_id: z.string().optional(),
        repo: z.string().optional(),
        mode: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (ctx.dryRun) {
          return {
            data: { executed: false, dry_run: true, repo: input.repo, mode: input.mode },
            audit: { before: null, after: input },
            summary: `DRY RUN: would trigger Depot CI build (mode="${input.mode}") for ${input.repo}. Pass dry_run=false to execute.`,
          };
        }

        let runId: string;
        let orgId: string;

        if (input.mode === 'dispatch') {
          if (!input.workflow)
            throw new Error('workflow is required when mode="dispatch".');
          if (!input.ref)
            throw new Error('ref is required when mode="dispatch".');
          const r = await dispatchWorkflow({
            repo: input.repo,
            workflow: input.workflow,
            ref: input.ref,
            inputs: input.inputs,
          });
          runId = r.runId;
          orgId = r.orgId;
        } else {
          const r = await triggerRun({
            repo: input.repo,
            sha: input.sha,
            workflow: input.workflow,
            job: input.job,
          });
          runId = r.runId;
          orgId = r.orgId;
        }

        return {
          data: { executed: true, dry_run: false, run_id: runId, org_id: orgId, repo: input.repo, mode: input.mode },
          audit: { before: null, after: { runId, orgId, repo: input.repo } },
          summary: `Triggered Depot CI build (mode="${input.mode}") for ${input.repo}. Run ID: ${runId}.`,
        };
      },
    },
    callerHash,
  );
}
