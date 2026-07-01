/**
 * Depot full-client — exhaustive Connect-RPC API coverage.
 *
 * Covers:
 *   Core v1: ProjectService (CRUD, reset, trust-policies, tokens), UsageService
 *   Build v1: BuildService (steps, step-logs), RegistryService (list/delete images)
 *   CI  v1:  CIService — Runs, Workflows, Jobs, Attempts, Logs, Artifacts, Diagnostics
 *
 * Auth: Bearer DEPOT_TOKEN via requireToken().
 * Protocol: Connect RPC over HTTP JSON (Content-Type: application/json,
 *           Connect-Protocol-Version: 1).
 * All methods are self-contained POST calls to https://api.depot.dev.
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();
const DEPOT_BASE = 'https://api.depot.dev';

// ── Error ─────────────────────────────────────────────────────────────────────

export class DepotFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'DepotFullError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireToken(): string {
  if (!env.DEPOT_TOKEN)
    throw new DepotFullError({
      code: 'depot_not_configured',
      status: 0,
      message: 'DEPOT_TOKEN not set.',
      nextStep: 'Add DEPOT_TOKEN (Organization Token) from the Depot settings to the vault.',
    });
  return env.DEPOT_TOKEN;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Connect RPC is POST-only by convention, so HTTP method cannot signal idempotency here;
 * the RPC verb does. Pass `idempotent: true` only for Get/List (read-only) calls; every
 * Create/Update/Delete/Reset/Add/Remove/Cancel/Retry/Rerun call defaults to retries:0 so a
 * timeout never duplicates a mutation, a CI cancel/retry, or a registry image deletion.
 */
async function post<T = any>(rpcPath: string, body: unknown, idempotent = false): Promise<T> {
  const token = requireToken();
  const res = await fetchWithBudget(`${DEPOT_BASE}${rpcPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body),
  }, { retries: idempotent ? 1 : 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400)
    throw new DepotFullError({
      code: `depot_${statusCode}`,
      status: statusCode,
      message: data?.message || data?.detail || `HTTP ${statusCode}`,
      nextStep: 'Verify DEPOT_TOKEN is valid and has the necessary access for this operation.',
    });
  return data as T;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE v1 — ProjectService
// ═══════════════════════════════════════════════════════════════════════════════

export async function getProject(opts: { projectId: string }): Promise<any> {
  return post('/depot.core.v1.ProjectService/GetProject', { projectId: opts.projectId }, true);
}

export async function createProject(opts: {
  name: string;
  regionId: string;
  cachePolicy?: { keepBytes?: number; keepDays?: number };
}): Promise<any> {
  return post('/depot.core.v1.ProjectService/CreateProject', {
    name: opts.name,
    regionId: opts.regionId,
    ...(opts.cachePolicy ? { cachePolicy: opts.cachePolicy } : {}),
  });
}

export async function updateProject(opts: {
  projectId: string;
  name?: string;
  cachePolicy?: { keepBytes?: number; keepDays?: number };
}): Promise<any> {
  const body: Record<string, unknown> = { projectId: opts.projectId };
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.cachePolicy) body.cachePolicy = opts.cachePolicy;
  return post('/depot.core.v1.ProjectService/UpdateProject', body);
}

export async function deleteProject(opts: { projectId: string }): Promise<any> {
  return post('/depot.core.v1.ProjectService/DeleteProject', { projectId: opts.projectId });
}

export async function resetProject(opts: { projectId: string }): Promise<any> {
  return post('/depot.core.v1.ProjectService/ResetProject', { projectId: opts.projectId });
}

// ── Trust Policies ────────────────────────────────────────────────────────────

export async function listTrustPolicies(opts: { projectId: string }): Promise<any> {
  return post('/depot.core.v1.ProjectService/ListTrustPolicies', { projectId: opts.projectId }, true);
}

export async function addTrustPolicy(opts: {
  projectId: string;
  provider: string;
  repository?: string;
  organizationId?: string;
  projectId2?: string;
  [k: string]: unknown;
}): Promise<any> {
  const { projectId, ...rest } = opts;
  return post('/depot.core.v1.ProjectService/AddTrustPolicy', { projectId, ...rest });
}

export async function removeTrustPolicy(opts: {
  projectId: string;
  trustPolicyId: string;
}): Promise<any> {
  return post('/depot.core.v1.ProjectService/RemoveTrustPolicy', {
    projectId: opts.projectId,
    trustPolicyId: opts.trustPolicyId,
  });
}

// ── Project Tokens ────────────────────────────────────────────────────────────

export async function listProjectTokens(opts: { projectId: string }): Promise<any> {
  return post('/depot.core.v1.ProjectService/ListTokens', { projectId: opts.projectId }, true);
}

export async function createProjectToken(opts: {
  projectId: string;
  description: string;
}): Promise<any> {
  // Returns { token: { tokenId, description, createdAt }, tokenValue } — tokenValue shown once.
  return post('/depot.core.v1.ProjectService/CreateToken', {
    projectId: opts.projectId,
    description: opts.description,
  });
}

export async function updateProjectToken(opts: {
  projectId: string;
  tokenId: string;
  description: string;
}): Promise<any> {
  return post('/depot.core.v1.ProjectService/UpdateToken', {
    projectId: opts.projectId,
    tokenId: opts.tokenId,
    description: opts.description,
  });
}

export async function deleteProjectToken(opts: {
  projectId: string;
  tokenId: string;
}): Promise<any> {
  return post('/depot.core.v1.ProjectService/DeleteToken', {
    projectId: opts.projectId,
    tokenId: opts.tokenId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE v1 — UsageService
// ═══════════════════════════════════════════════════════════════════════════════

export async function listProjectUsage(opts: {
  startTime?: string;
  endTime?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.startTime) body.startTime = opts.startTime;
  if (opts.endTime) body.endTime = opts.endTime;
  return post('/depot.core.v1.UsageService/ListProjectUsage', body, true);
}

export async function getProjectUsage(opts: {
  projectId: string;
  startTime?: string;
  endTime?: string;
}): Promise<any> {
  const body: Record<string, unknown> = { projectId: opts.projectId };
  if (opts.startTime) body.startTime = opts.startTime;
  if (opts.endTime) body.endTime = opts.endTime;
  return post('/depot.core.v1.UsageService/GetProjectUsage', body, true);
}

export async function getUsage(opts: {
  startTime?: string;
  endTime?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.startTime) body.startTime = opts.startTime;
  if (opts.endTime) body.endTime = opts.endTime;
  return post('/depot.core.v1.UsageService/GetUsage', body, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD v1 — BuildService
// ═══════════════════════════════════════════════════════════════════════════════

export async function getBuildSteps(opts: { buildId: string }): Promise<any> {
  return post('/depot.build.v1.BuildService/GetBuildSteps', { buildId: opts.buildId }, true);
}

export async function getBuildStepLogs(opts: {
  buildId: string;
  stepId: string;
}): Promise<any> {
  return post('/depot.build.v1.BuildService/GetBuildStepLogs', {
    buildId: opts.buildId,
    stepId: opts.stepId,
  }, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD v1 — RegistryService (images per project)
// ═══════════════════════════════════════════════════════════════════════════════

export async function listRegistryImages(opts: { projectId: string }): Promise<any> {
  return post('/depot.build.v1.RegistryService/ListImages', { projectId: opts.projectId }, true);
}

export async function deleteRegistryImages(opts: {
  projectId: string;
  digests: string[];
}): Promise<any> {
  return post('/depot.build.v1.RegistryService/DeleteImages', {
    projectId: opts.projectId,
    digests: opts.digests,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Runs
// ═══════════════════════════════════════════════════════════════════════════════

export async function listRuns(opts: {
  status?: string[];
  pageSize?: number;
  pageToken?: string;
  repo?: string;
  sha?: string;
  trigger?: string;
  pr?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.status?.length) body.status = opts.status;
  if (opts.pageSize) body.pageSize = opts.pageSize;
  if (opts.pageToken) body.pageToken = opts.pageToken;
  if (opts.repo) body.repo = opts.repo;
  if (opts.sha) body.sha = opts.sha;
  if (opts.trigger) body.trigger = opts.trigger;
  if (opts.pr) body.pr = opts.pr;
  return post('/depot.ci.v1.CIService/ListRuns', body, true);
}

export async function getRun(opts: { runId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetRun', { runId: opts.runId }, true);
}

export async function getRunStatus(opts: { runId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetRunStatus', { runId: opts.runId }, true);
}

export async function getRunMetrics(opts: { runId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetRunMetrics', { runId: opts.runId }, true);
}

export async function cancelRun(opts: { runId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/CancelRun', { runId: opts.runId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Workflows
// ═══════════════════════════════════════════════════════════════════════════════

export async function listWorkflows(opts: {
  pageSize?: number;
  name?: string;
  repo?: string;
  status?: string[];
  trigger?: string;
  sha?: string;
  pr?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.pageSize) body.pageSize = opts.pageSize;
  if (opts.name) body.name = opts.name;
  if (opts.repo) body.repo = opts.repo;
  if (opts.status?.length) body.status = opts.status;
  if (opts.trigger) body.trigger = opts.trigger;
  if (opts.sha) body.sha = opts.sha;
  if (opts.pr) body.pr = opts.pr;
  return post('/depot.ci.v1.CIService/ListWorkflows', body, true);
}

export async function getWorkflow(opts: { workflowId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetWorkflow', { workflowId: opts.workflowId }, true);
}

export async function rerunWorkflow(opts: { workflowId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/RerunWorkflow', { workflowId: opts.workflowId });
}

export async function cancelWorkflow(opts: { workflowId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/CancelWorkflow', { workflowId: opts.workflowId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Jobs
// ═══════════════════════════════════════════════════════════════════════════════

export async function getJob(opts: { jobId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetJob', { jobId: opts.jobId }, true);
}

export async function getJobSummary(opts: {
  jobId?: string;
  attemptId?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.jobId) body.jobId = opts.jobId;
  if (opts.attemptId) body.attemptId = opts.attemptId;
  return post('/depot.ci.v1.CIService/GetJobSummary', body, true);
}

export async function getJobMetrics(opts: { jobId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetJobMetrics', { jobId: opts.jobId }, true);
}

export async function retryJob(opts: { workflowId: string; jobId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/RetryJob', {
    workflowId: opts.workflowId,
    jobId: opts.jobId,
  });
}

export async function retryFailedJobs(opts: { workflowId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/RetryFailedJobs', { workflowId: opts.workflowId });
}

export async function cancelJob(opts: { workflowId: string; jobId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/CancelJob', {
    workflowId: opts.workflowId,
    jobId: opts.jobId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Attempts
// ═══════════════════════════════════════════════════════════════════════════════

export async function getAttempt(opts: { attemptId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetAttempt', { attemptId: opts.attemptId }, true);
}

export async function getJobAttemptMetrics(opts: { attemptId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetJobAttemptMetrics', { attemptId: opts.attemptId }, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Logs
// ═══════════════════════════════════════════════════════════════════════════════

export async function getJobAttemptLogs(opts: {
  attemptId?: string;
  jobId?: string;
  pageToken?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.attemptId) body.attemptId = opts.attemptId;
  if (opts.jobId) body.jobId = opts.jobId;
  if (opts.pageToken) body.pageToken = opts.pageToken;
  return post('/depot.ci.v1.CIService/GetJobAttemptLogs', body, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Artifacts
// ═══════════════════════════════════════════════════════════════════════════════

export async function listArtifacts(opts: {
  runId: string;
  workflowId?: string;
  jobId?: string;
  attemptId?: string;
}): Promise<any> {
  const body: Record<string, unknown> = { runId: opts.runId };
  if (opts.workflowId) body.workflowId = opts.workflowId;
  if (opts.jobId) body.jobId = opts.jobId;
  if (opts.attemptId) body.attemptId = opts.attemptId;
  return post('/depot.ci.v1.CIService/ListArtifacts', body, true);
}

export async function getArtifactDownloadUrl(opts: { artifactId: string }): Promise<any> {
  return post('/depot.ci.v1.CIService/GetArtifactDownloadURL', {
    artifactId: opts.artifactId,
  }, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CI v1 — CIService: Diagnostics
// ═══════════════════════════════════════════════════════════════════════════════

export async function getFailureDiagnosis(opts: {
  runId?: string;
  workflowId?: string;
  jobId?: string;
  attemptId?: string;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  if (opts.runId) body.runId = opts.runId;
  if (opts.workflowId) body.workflowId = opts.workflowId;
  if (opts.jobId) body.jobId = opts.jobId;
  if (opts.attemptId) body.attemptId = opts.attemptId;
  return post('/depot.ci.v1.CIService/GetFailureDiagnosis', body, true);
}
