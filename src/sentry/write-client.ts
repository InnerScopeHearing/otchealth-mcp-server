import { loadEnv } from '../config/env.js';
import { isPhiProject } from './api-client.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class SentryWriteError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'SentryWriteError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}

function org(): string { return env.SENTRY_ORG || 'otchealth-inc'; }
function base(): string { return 'https://us.sentry.io/api/0'; }

function requireKey(): string {
  if (!env.SENTRY_AUTH_TOKEN) throw new SentryWriteError({ code: 'sentry_not_configured', status: 0, message: 'SENTRY_AUTH_TOKEN not set.', nextStep: 'Add SENTRY_AUTH_TOKEN from the vault.' });
  return env.SENTRY_AUTH_TOKEN;
}

function assertNotPhi(projectSlug: string): void {
  if (isPhiProject(projectSlug)) {
    throw new SentryWriteError({
      code: 'sentry_phi_blocked',
      status: 403,
      message: `Project "${projectSlug}" is a MedReview PHI project and MUST NOT be accessed or mutated via this gateway.`,
      nextStep: 'Use the BAA-covered MedReview engine for PHI project operations.',
    });
  }
}

async function sentryPut<T = any>(path: string, body: unknown): Promise<T> {
  const key = requireKey();
  // Non-idempotent write (issue status/assignee update, release update): retries:0 so a
  // timeout never causes a duplicate mutation.
  const res = await fetchWithBudget(`${base()}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new SentryWriteError({ code: `sentry_${statusCode}`, status: statusCode, message: data?.detail || `HTTP ${statusCode}`, nextStep: 'Verify SENTRY_AUTH_TOKEN scope + org/project slug.' });
  return data as T;
}

async function sentryPost<T = any>(path: string, body: unknown): Promise<T> {
  const key = requireKey();
  // Non-idempotent write (creates a release): retries:0 so a timeout never creates a
  // duplicate release.
  const res = await fetchWithBudget(`${base()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new SentryWriteError({ code: `sentry_${statusCode}`, status: statusCode, message: data?.detail || `HTTP ${statusCode}`, nextStep: 'Verify SENTRY_AUTH_TOKEN scope + org slug.' });
  return data as T;
}

// --- Write operations ---

export interface UpdateIssueParams {
  /** Sentry issue numeric ID (e.g. 123456789) */
  issueId: string;
  /** The project slug — required only for PHI guard; not sent in path (issue IDs are global). */
  projectSlug: string;
  status?: 'resolved' | 'ignored' | 'unresolved';
  assignedTo?: string;
}

export async function updateIssue(params: UpdateIssueParams): Promise<any> {
  assertNotPhi(params.projectSlug);
  const payload: Record<string, unknown> = {};
  if (params.status !== undefined) payload.status = params.status;
  if (params.assignedTo !== undefined) payload.assignedTo = params.assignedTo;
  return sentryPut(`/issues/${encodeURIComponent(params.issueId)}/`, payload);
}

export interface CreateReleaseParams {
  version: string;
  /** Project slugs to associate with this release. PHI projects are blocked. */
  projects: string[];
  ref?: string;
  url?: string;
  dateReleased?: string;
}

export async function createRelease(params: CreateReleaseParams): Promise<any> {
  // Refuse if ANY of the target projects is PHI.
  for (const slug of params.projects) {
    assertNotPhi(slug);
  }
  const payload: Record<string, unknown> = {
    version: params.version,
    projects: params.projects,
  };
  if (params.ref !== undefined) payload.ref = params.ref;
  if (params.url !== undefined) payload.url = params.url;
  if (params.dateReleased !== undefined) payload.dateReleased = params.dateReleased;
  return sentryPost(`/organizations/${encodeURIComponent(org())}/releases/`, payload);
}
