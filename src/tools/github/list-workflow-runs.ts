import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { listWorkflowRuns, assertRepoAllowed } from '../../github/api-client.js';

// GET /repos/{owner}/{repo}/actions/runs (REST API 2022-11-28) folds BOTH "check run status" and
// "conclusion" values into this one query parameter for the list-runs endpoint -- GitHub's own docs
// describe it as "Returns workflow runs with the check run status or conclusion that you specify."
// There is no separate "conclusion" filter here (unlike a single run object, which has distinct
// status/conclusion fields). Declaring this as an explicit enum -- rather than a bare z.string() --
// is deliberate: it is what makes an unsupported value (e.g. a typo, or a value GitHub does not
// support here) an EXPLICIT Zod validation error instead of a value that is silently forwarded (or,
// before this fix, a value that never reached the API at all -- see the regression test file for the
// defect this closes).
const WORKFLOW_RUN_STATUS_VALUES = [
  'completed',
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'success',
  'timed_out',
  'in_progress',
  'queued',
  'requested',
  'waiting',
  'pending',
] as const;

export function registerGitHubListWorkflowRuns(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'github_list_workflow_runs', category: 'read',
    annotations: { title: 'List GitHub workflow runs', description: 'List recent Actions workflow runs for a GitHub repository, optionally filtered by status, branch, event, actor, or creation date. Read-only.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {
      owner: z.string().describe('Repository owner (user or org), e.g. "octocat".'),
      repo: z.string().describe('Repository name, e.g. "hello-world".'),
      status: z.enum(WORKFLOW_RUN_STATUS_VALUES).optional().describe(
        `Filter by run status/conclusion. GitHub uses ONE combined enum for this endpoint: ${WORKFLOW_RUN_STATUS_VALUES.join(', ')}. ` +
        'For example, use "waiting" to find a run blocked on an environment-protection approval, or "in_progress" for a currently-running run. An unsupported value is rejected, not silently ignored.',
      ),
      branch: z.string().optional().describe('Only runs associated with this branch name.'),
      event: z.string().optional().describe('Only runs triggered by this event, e.g. "push", "pull_request", "workflow_dispatch", "schedule".'),
      actor: z.string().optional().describe('Only runs created by this GitHub username.'),
      created: z.string().optional().describe('Date or date-range filter on run creation time, e.g. ">=2026-08-01" or "2026-08-01..2026-08-15".'),
      exclude_pull_requests: z.boolean().optional().describe('Exclude runs triggered by a pull request from the results.'),
      check_suite_id: z.number().int().optional().describe('Only runs belonging to this check suite id.'),
      head_sha: z.string().optional().describe('Only the run(s) associated with this exact commit SHA.'),
      per_page: z.number().int().min(1).max(100).optional().describe('Results per page, GitHub max 100 (default 20).'),
      page: z.number().int().min(1).optional().describe('Page number for pagination (default 1).'),
    },
    outputShape: { runs: z.array(z.unknown()), count: z.number() },
    handler: async (input, ctx) => {
      assertRepoAllowed(ctx.callerAgent, input.owner, input.repo);
      const runs = await listWorkflowRuns(input.owner, input.repo, {
        status: input.status,
        branch: input.branch,
        event: input.event,
        actor: input.actor,
        created: input.created,
        exclude_pull_requests: input.exclude_pull_requests,
        check_suite_id: input.check_suite_id,
        head_sha: input.head_sha,
        per_page: input.per_page,
        page: input.page,
      });
      return {
        data: {
          runs: runs.map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, head_branch: r.head_branch, created_at: r.created_at })),
          count: runs.length,
        },
        summary: `${runs.length} workflow run(s) in ${input.owner}/${input.repo}${input.status ? ` (status=${input.status})` : ''}`,
      };
    },
  }, callerHash);
}
