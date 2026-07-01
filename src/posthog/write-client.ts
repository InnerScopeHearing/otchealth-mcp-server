import { loadEnv } from '../config/env.js';
import { isPhiProject } from './api-client.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

export class PostHogWriteError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'PostHogWriteError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}

function host(): string { return env.POSTHOG_HOST || 'https://us.posthog.com'; }

function requireKey(): string {
  if (!env.POSTHOG_PERSONAL_API_KEY) throw new PostHogWriteError({ code: 'posthog_not_configured', status: 0, message: 'POSTHOG_PERSONAL_API_KEY not set.', nextStep: 'Add POSTHOG_PERSONAL_API_KEY from the vault.' });
  return env.POSTHOG_PERSONAL_API_KEY;
}

function assertNotPhi(projectId: string | number): void {
  if (isPhiProject(projectId)) {
    throw new PostHogWriteError({
      code: 'posthog_phi_blocked',
      status: 403,
      message: `PostHog project ${projectId} is the MedReview PHI project (468398) and MUST NOT be accessed or mutated via this gateway.`,
      nextStep: 'Use the BAA-covered MedReview engine for PHI project operations.',
    });
  }
}

async function phPost<T = any>(path: string, body: unknown): Promise<T> {
  const key = requireKey();
  // Non-idempotent write (create an annotation or feature flag): retries:0 so a
  // timeout never causes a duplicate create.
  const res = await fetchWithBudget(`${host()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new PostHogWriteError({ code: `posthog_${statusCode}`, status: statusCode, message: data?.detail || data?.message || `HTTP ${statusCode}`, nextStep: 'Verify POSTHOG_PERSONAL_API_KEY scope + project id.' });
  return data as T;
}

async function phPatch<T = any>(path: string, body: unknown): Promise<T> {
  const key = requireKey();
  // Non-idempotent write (update a feature flag): retries:0 so a timeout never
  // causes a racing/duplicate update.
  const res = await fetchWithBudget(`${host()}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new PostHogWriteError({ code: `posthog_${statusCode}`, status: statusCode, message: data?.detail || data?.message || `HTTP ${statusCode}`, nextStep: 'Verify POSTHOG_PERSONAL_API_KEY scope + project id + flag id.' });
  return data as T;
}

// --- Write operations ---

export interface CreateAnnotationParams {
  project_id: string | number;
  content: string;
  /** ISO 8601 datetime, e.g. "2026-06-26T00:00:00Z". Defaults to now on the server. */
  date_marker?: string;
  /** Annotation scope: "project" or "organization". Default: "project". */
  scope?: 'project' | 'organization';
}

export async function createAnnotation(params: CreateAnnotationParams): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = { content: params.content };
  if (params.date_marker !== undefined) payload.date_marker = params.date_marker;
  if (params.scope !== undefined) payload.scope = params.scope;
  return phPost(`/api/projects/${encodeURIComponent(String(params.project_id))}/annotations/`, payload);
}

export interface CreateFeatureFlagParams {
  project_id: string | number;
  key: string;
  name?: string;
  active?: boolean;
  /** Rollout percentage 0-100. Applied as a simple person rollout if provided. */
  rollout_percentage?: number;
  filters?: Record<string, unknown>;
}

export async function createFeatureFlag(params: CreateFeatureFlagParams): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = { key: params.key };
  if (params.name !== undefined) payload.name = params.name;
  if (params.active !== undefined) payload.active = params.active;
  if (params.filters !== undefined) {
    payload.filters = params.filters;
  } else if (params.rollout_percentage !== undefined) {
    payload.filters = {
      groups: [{ properties: [], rollout_percentage: params.rollout_percentage }],
    };
  }
  return phPost(`/api/projects/${encodeURIComponent(String(params.project_id))}/feature_flags/`, payload);
}

export interface UpdateFeatureFlagParams {
  project_id: string | number;
  flag_id: number | string;
  active?: boolean;
  name?: string;
  rollout_percentage?: number;
  filters?: Record<string, unknown>;
}

export async function updateFeatureFlag(params: UpdateFeatureFlagParams): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.active !== undefined) payload.active = params.active;
  if (params.name !== undefined) payload.name = params.name;
  if (params.filters !== undefined) {
    payload.filters = params.filters;
  } else if (params.rollout_percentage !== undefined) {
    payload.filters = {
      groups: [{ properties: [], rollout_percentage: params.rollout_percentage }],
    };
  }
  return phPatch(
    `/api/projects/${encodeURIComponent(String(params.project_id))}/feature_flags/${encodeURIComponent(String(params.flag_id))}/`,
    payload,
  );
}
