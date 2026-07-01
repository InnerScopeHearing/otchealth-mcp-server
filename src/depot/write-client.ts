/**
 * Depot write-client — CTO-gated CI dispatch operations.
 *
 * Depot has a native CI API (Connect RPC over HTTP JSON) at https://api.depot.dev.
 * Auth is identical to the read api-client: Bearer DEPOT_TOKEN.
 *
 * This client implements:
 *   - triggerRun       — POST /depot.ci.v1.CIService/Run (trigger a full CI run)
 *   - dispatchWorkflow — POST /depot.ci.v1.CIService/DispatchWorkflow (on.workflow_dispatch)
 *
 * Note: Depot CI is the fleet's primary CI system (workflows live under .depot/workflows/).
 * If this fleet's iOS/build workflows remain on GitHub Actions and are NOT yet migrated to
 * Depot CI, the operator should use github_dispatch_workflow against the GitHub Actions
 * workflow instead. depot_trigger_build delegates to the Depot native API since Depot CI
 * has been GA since June 2026.
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ── Error class (mirrors DepotApiError shape) ─────────────────────────────────

export class DepotWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;

  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'DepotWriteError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireToken(): string {
  if (!env.DEPOT_TOKEN)
    throw new DepotWriteError({
      code: 'depot_not_configured',
      status: 0,
      message: 'DEPOT_TOKEN not set.',
      nextStep: 'Add DEPOT_TOKEN (Organization Token) from the Depot settings to the vault.',
    });
  return env.DEPOT_TOKEN;
}

const DEPOT_BASE = 'https://api.depot.dev';

// ── Core HTTP helper ──────────────────────────────────────────────────────────

async function depotPost<T = any>(rpcPath: string, body: unknown): Promise<T> {
  const token = requireToken();
  // Both callers (triggerRun, dispatchWorkflow) kick off a real CI run: retries:0 so a
  // timeout never triggers a duplicate build.
  const res = await fetchWithBudget(`${DEPOT_BASE}${rpcPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Required by the Connect RPC protocol
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400)
    throw new DepotWriteError({
      code: `depot_${statusCode}`,
      status: statusCode,
      message: data?.message || data?.detail || `HTTP ${statusCode}`,
      nextStep: 'Verify DEPOT_TOKEN is valid and has CI dispatch access for this organization.',
    });
  return data as T;
}

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Trigger a Depot CI run for a repository. Optionally scope to a single workflow
 * file and/or a single job within that workflow. Returns the new run ID.
 *
 * Maps to: POST /depot.ci.v1.CIService/Run
 *
 * `repo` must be in "owner/name" format (e.g. "InnerScopeHearing/otchealth-ios").
 */
export async function triggerRun(opts: {
  repo: string;           // "owner/name" format
  sha?: string;           // full 40-char commit SHA; defaults to HEAD of default branch
  workflow?: string;      // path relative to repo root, e.g. ".depot/workflows/ci.yml"
  job?: string;           // single job key within the workflow
}): Promise<{ runId: string; orgId: string }> {
  const body: Record<string, unknown> = { repo: opts.repo };
  if (opts.sha) body.sha = opts.sha;
  if (opts.workflow) body.workflow = opts.workflow;
  if (opts.job) body.job = opts.job;

  const r = await depotPost<{ runId: string; orgId: string }>(
    '/depot.ci.v1.CIService/Run',
    body,
  );
  return { runId: r.runId, orgId: r.orgId };
}

/**
 * Dispatch a single workflow that has an `on.workflow_dispatch` trigger in its
 * YAML. Inputs are validated by Depot against the workflow's declared input schema.
 *
 * Maps to: POST /depot.ci.v1.CIService/DispatchWorkflow
 *
 * `workflow` is the basename of the workflow file (e.g. "deploy.yml"), NOT the
 * full path. `ref` is the branch or tag to run against.
 */
export async function dispatchWorkflow(opts: {
  repo: string;           // "owner/name" format
  workflow: string;       // basename, e.g. "deploy.yml"
  ref: string;            // branch or tag
  inputs?: Record<string, string>;
}): Promise<{ runId: string; orgId: string }> {
  const body: Record<string, unknown> = {
    repo: opts.repo,
    workflow: opts.workflow,
    ref: opts.ref,
    inputs: opts.inputs ?? {},
  };

  const r = await depotPost<{ runId: string; orgId: string }>(
    '/depot.ci.v1.CIService/DispatchWorkflow',
    body,
  );
  return { runId: r.runId, orgId: r.orgId };
}
