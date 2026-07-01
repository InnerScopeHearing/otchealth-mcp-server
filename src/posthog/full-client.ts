/**
 * PostHog Full API Client — exhaustive CRUD surface.
 * Self-contained: auth + request helpers copied from api-client.ts.
 * PHI ring guard: project 468398 (MedReview) is blocked on every mutating
 * AND read operation — no data at all flows for that project.
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------
export class PostHogFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'PostHogFullError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

// ---------------------------------------------------------------------------
// PHI ring guard — project 468398 is MedReview PHI — NEVER expose via gateway
// ---------------------------------------------------------------------------
export function isPhiProject(id: string | number): boolean {
  return String(id) === '468398';
}

function assertNotPhi(projectId: string | number): void {
  if (isPhiProject(projectId)) {
    throw new PostHogFullError({
      code: 'posthog_phi_blocked',
      status: 403,
      message: `PostHog project ${projectId} is the MedReview PHI project (468398) and MUST NOT be accessed via this gateway.`,
      nextStep: 'Use the BAA-covered MedReview engine for PHI project operations.',
    });
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function host(): string {
  return env.POSTHOG_HOST || 'https://us.posthog.com';
}

function requireKey(): string {
  if (!env.POSTHOG_PERSONAL_API_KEY) {
    throw new PostHogFullError({
      code: 'posthog_not_configured',
      status: 0,
      message: 'POSTHOG_PERSONAL_API_KEY not set.',
      nextStep: 'Add POSTHOG_PERSONAL_API_KEY from the vault.',
    });
  }
  return env.POSTHOG_PERSONAL_API_KEY;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function ph<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const key = requireKey();
  const url = `${host()}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // GET is read-only (retries:1); POST/PATCH/PUT/DELETE mutate feature flags, insights,
  // dashboards, annotations, cohorts, persons, experiments, surveys, actions, and the
  // project itself (also used for queryHogQL, a read-shaped POST): retries:0 to avoid a
  // duplicate mutation on a timeout.
  const retries = method === 'GET' ? 1 : 0;
  const res = await fetchWithBudget(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, { retries });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (statusCode >= 400) {
    throw new PostHogFullError({
      code: `posthog_${statusCode}`,
      status: statusCode,
      message: data?.detail || data?.message || `HTTP ${statusCode}`,
      nextStep: 'Verify POSTHOG_PERSONAL_API_KEY scope + project id.',
    });
  }
  return data as T;
}

function pGet<T = any>(path: string): Promise<T> {
  return ph<T>('GET', path);
}
function pPost<T = any>(path: string, body: unknown): Promise<T> {
  return ph<T>('POST', path, body);
}
function pPatch<T = any>(path: string, body: unknown): Promise<T> {
  return ph<T>('PATCH', path, body);
}
function pDelete<T = any>(path: string): Promise<T> {
  return ph<T>('DELETE', path);
}

function enc(v: string | number): string {
  return encodeURIComponent(String(v));
}

function proj(projectId: string | number): string {
  return `/api/projects/${enc(projectId)}`;
}

// ---------------------------------------------------------------------------
// FEATURE FLAGS
// ---------------------------------------------------------------------------
export async function listFeatureFlags(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/feature_flags/${q ? '?' + q : ''}`);
}

export async function getFeatureFlag(params: {
  project_id: string | number;
  flag_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/feature_flags/${enc(params.flag_id)}/`);
}

export async function deleteFeatureFlag(params: {
  project_id: string | number;
  flag_id: string | number;
}): Promise<void> {
  assertNotPhi(params.project_id);
  await pDelete(`${proj(params.project_id)}/feature_flags/${enc(params.flag_id)}/`);
}

// ---------------------------------------------------------------------------
// INSIGHTS
// ---------------------------------------------------------------------------
export async function listInsights(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
  saved?: boolean;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.saved !== undefined) qs.set('saved', String(params.saved));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/insights/${q ? '?' + q : ''}`);
}

export async function getInsight(params: {
  project_id: string | number;
  insight_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/insights/${enc(params.insight_id)}/`);
}

export async function createInsight(params: {
  project_id: string | number;
  name?: string;
  description?: string;
  filters?: Record<string, unknown>;
  query?: Record<string, unknown>;
  saved?: boolean;
  dashboards?: number[];
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.filters !== undefined) payload.filters = params.filters;
  if (params.query !== undefined) payload.query = params.query;
  if (params.saved !== undefined) payload.saved = params.saved;
  if (params.dashboards !== undefined) payload.dashboards = params.dashboards;
  return pPost(`${proj(params.project_id)}/insights/`, payload);
}

export async function updateInsight(params: {
  project_id: string | number;
  insight_id: string | number;
  name?: string;
  description?: string;
  filters?: Record<string, unknown>;
  query?: Record<string, unknown>;
  saved?: boolean;
  dashboards?: number[];
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.filters !== undefined) payload.filters = params.filters;
  if (params.query !== undefined) payload.query = params.query;
  if (params.saved !== undefined) payload.saved = params.saved;
  if (params.dashboards !== undefined) payload.dashboards = params.dashboards;
  return pPatch(`${proj(params.project_id)}/insights/${enc(params.insight_id)}/`, payload);
}

export async function deleteInsight(params: {
  project_id: string | number;
  insight_id: string | number;
}): Promise<void> {
  assertNotPhi(params.project_id);
  await pDelete(`${proj(params.project_id)}/insights/${enc(params.insight_id)}/`);
}

// ---------------------------------------------------------------------------
// DASHBOARDS
// ---------------------------------------------------------------------------
export async function listDashboards(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/dashboards/${q ? '?' + q : ''}`);
}

export async function getDashboard(params: {
  project_id: string | number;
  dashboard_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/dashboards/${enc(params.dashboard_id)}/`);
}

export async function createDashboard(params: {
  project_id: string | number;
  name: string;
  description?: string;
  tags?: string[];
  pinned?: boolean;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = { name: params.name };
  if (params.description !== undefined) payload.description = params.description;
  if (params.tags !== undefined) payload.tags = params.tags;
  if (params.pinned !== undefined) payload.pinned = params.pinned;
  return pPost(`${proj(params.project_id)}/dashboards/`, payload);
}

export async function updateDashboard(params: {
  project_id: string | number;
  dashboard_id: string | number;
  name?: string;
  description?: string;
  tags?: string[];
  pinned?: boolean;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.tags !== undefined) payload.tags = params.tags;
  if (params.pinned !== undefined) payload.pinned = params.pinned;
  return pPatch(`${proj(params.project_id)}/dashboards/${enc(params.dashboard_id)}/`, payload);
}

export async function deleteDashboard(params: {
  project_id: string | number;
  dashboard_id: string | number;
}): Promise<void> {
  assertNotPhi(params.project_id);
  await pDelete(`${proj(params.project_id)}/dashboards/${enc(params.dashboard_id)}/`);
}

// ---------------------------------------------------------------------------
// ANNOTATIONS
// ---------------------------------------------------------------------------
export async function listAnnotations(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/annotations/${q ? '?' + q : ''}`);
}

export async function getAnnotation(params: {
  project_id: string | number;
  annotation_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/annotations/${enc(params.annotation_id)}/`);
}

export async function updateAnnotation(params: {
  project_id: string | number;
  annotation_id: string | number;
  content?: string;
  date_marker?: string;
  scope?: 'project' | 'organization';
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.content !== undefined) payload.content = params.content;
  if (params.date_marker !== undefined) payload.date_marker = params.date_marker;
  if (params.scope !== undefined) payload.scope = params.scope;
  return pPatch(`${proj(params.project_id)}/annotations/${enc(params.annotation_id)}/`, payload);
}

export async function deleteAnnotation(params: {
  project_id: string | number;
  annotation_id: string | number;
}): Promise<void> {
  assertNotPhi(params.project_id);
  await pDelete(`${proj(params.project_id)}/annotations/${enc(params.annotation_id)}/`);
}

// ---------------------------------------------------------------------------
// COHORTS
// ---------------------------------------------------------------------------
export async function listCohorts(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/cohorts/${q ? '?' + q : ''}`);
}

export async function getCohort(params: {
  project_id: string | number;
  cohort_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/cohorts/${enc(params.cohort_id)}/`);
}

export async function createCohort(params: {
  project_id: string | number;
  name: string;
  description?: string;
  filters?: Record<string, unknown>;
  groups?: Record<string, unknown>[];
  is_static?: boolean;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = { name: params.name };
  if (params.description !== undefined) payload.description = params.description;
  if (params.filters !== undefined) payload.filters = params.filters;
  if (params.groups !== undefined) payload.groups = params.groups;
  if (params.is_static !== undefined) payload.is_static = params.is_static;
  return pPost(`${proj(params.project_id)}/cohorts/`, payload);
}

export async function updateCohort(params: {
  project_id: string | number;
  cohort_id: string | number;
  name?: string;
  description?: string;
  filters?: Record<string, unknown>;
  groups?: Record<string, unknown>[];
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.filters !== undefined) payload.filters = params.filters;
  if (params.groups !== undefined) payload.groups = params.groups;
  return pPatch(`${proj(params.project_id)}/cohorts/${enc(params.cohort_id)}/`, payload);
}

export async function deleteCohort(params: {
  project_id: string | number;
  cohort_id: string | number;
}): Promise<void> {
  assertNotPhi(params.project_id);
  await pDelete(`${proj(params.project_id)}/cohorts/${enc(params.cohort_id)}/`);
}

// ---------------------------------------------------------------------------
// PERSONS
// ---------------------------------------------------------------------------
export async function listPersons(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
  search?: string;
  cohort?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.search !== undefined) qs.set('search', params.search);
  if (params.cohort !== undefined) qs.set('cohort', String(params.cohort));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/persons/${q ? '?' + q : ''}`);
}

export async function getPerson(params: {
  project_id: string | number;
  person_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/persons/${enc(params.person_id)}/`);
}

export async function updatePerson(params: {
  project_id: string | number;
  person_id: string | number;
  properties?: Record<string, unknown>;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.properties !== undefined) payload.properties = params.properties;
  return pPatch(`${proj(params.project_id)}/persons/${enc(params.person_id)}/`, payload);
}

export async function deletePerson(params: {
  project_id: string | number;
  person_id: string | number;
  delete_events?: boolean;
}): Promise<void> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.delete_events) qs.set('delete_events', 'true');
  const q = qs.toString();
  await pDelete(`${proj(params.project_id)}/persons/${enc(params.person_id)}/${q ? '?' + q : ''}`);
}

export async function listPersonActivity(params: {
  project_id: string | number;
  person_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/persons/${enc(params.person_id)}/activity/`);
}

// ---------------------------------------------------------------------------
// EVENTS (query + definitions)
// ---------------------------------------------------------------------------
export async function queryHogQL(params: {
  project_id: string | number;
  query: string;
  limit?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {
    query: { kind: 'HogQLQuery', query: params.query },
  };
  if (params.limit !== undefined) {
    (payload.query as Record<string, unknown>).limit = params.limit;
  }
  return pPost(`${proj(params.project_id)}/query/`, payload);
}

export async function listEventDefinitions(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.search !== undefined) qs.set('search', params.search);
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/event_definitions/${q ? '?' + q : ''}`);
}

export async function listPropertyDefinitions(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
  search?: string;
  type?: 'event' | 'person' | 'group' | 'session';
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.search !== undefined) qs.set('search', params.search);
  if (params.type !== undefined) qs.set('type', params.type);
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/property_definitions/${q ? '?' + q : ''}`);
}

// ---------------------------------------------------------------------------
// EXPERIMENTS
// ---------------------------------------------------------------------------
export async function listExperiments(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/experiments/${q ? '?' + q : ''}`);
}

export async function getExperiment(params: {
  project_id: string | number;
  experiment_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/experiments/${enc(params.experiment_id)}/`);
}

export async function createExperiment(params: {
  project_id: string | number;
  name: string;
  description?: string;
  feature_flag_key: string;
  filters?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  secondary_metrics?: Record<string, unknown>[];
  start_date?: string;
  end_date?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {
    name: params.name,
    feature_flag_key: params.feature_flag_key,
  };
  if (params.description !== undefined) payload.description = params.description;
  if (params.filters !== undefined) payload.filters = params.filters;
  if (params.parameters !== undefined) payload.parameters = params.parameters;
  if (params.secondary_metrics !== undefined) payload.secondary_metrics = params.secondary_metrics;
  if (params.start_date !== undefined) payload.start_date = params.start_date;
  if (params.end_date !== undefined) payload.end_date = params.end_date;
  return pPost(`${proj(params.project_id)}/experiments/`, payload);
}

export async function updateExperiment(params: {
  project_id: string | number;
  experiment_id: string | number;
  name?: string;
  description?: string;
  filters?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  start_date?: string;
  end_date?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.filters !== undefined) payload.filters = params.filters;
  if (params.parameters !== undefined) payload.parameters = params.parameters;
  if (params.start_date !== undefined) payload.start_date = params.start_date;
  if (params.end_date !== undefined) payload.end_date = params.end_date;
  return pPatch(`${proj(params.project_id)}/experiments/${enc(params.experiment_id)}/`, payload);
}

// ---------------------------------------------------------------------------
// SURVEYS
// ---------------------------------------------------------------------------
export async function listSurveys(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/surveys/${q ? '?' + q : ''}`);
}

export async function getSurvey(params: {
  project_id: string | number;
  survey_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/surveys/${enc(params.survey_id)}/`);
}

export async function createSurvey(params: {
  project_id: string | number;
  name: string;
  description?: string;
  type: 'popover' | 'button' | 'email' | 'full_screen';
  questions?: Record<string, unknown>[];
  conditions?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  start_date?: string;
  end_date?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = { name: params.name, type: params.type };
  if (params.description !== undefined) payload.description = params.description;
  if (params.questions !== undefined) payload.questions = params.questions;
  if (params.conditions !== undefined) payload.conditions = params.conditions;
  if (params.appearance !== undefined) payload.appearance = params.appearance;
  if (params.start_date !== undefined) payload.start_date = params.start_date;
  if (params.end_date !== undefined) payload.end_date = params.end_date;
  return pPost(`${proj(params.project_id)}/surveys/`, payload);
}

export async function updateSurvey(params: {
  project_id: string | number;
  survey_id: string | number;
  name?: string;
  description?: string;
  questions?: Record<string, unknown>[];
  conditions?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  start_date?: string;
  end_date?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.questions !== undefined) payload.questions = params.questions;
  if (params.conditions !== undefined) payload.conditions = params.conditions;
  if (params.appearance !== undefined) payload.appearance = params.appearance;
  if (params.start_date !== undefined) payload.start_date = params.start_date;
  if (params.end_date !== undefined) payload.end_date = params.end_date;
  return pPatch(`${proj(params.project_id)}/surveys/${enc(params.survey_id)}/`, payload);
}

// ---------------------------------------------------------------------------
// ACTIONS
// ---------------------------------------------------------------------------
export async function listActions(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/actions/${q ? '?' + q : ''}`);
}

export async function getAction(params: {
  project_id: string | number;
  action_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/actions/${enc(params.action_id)}/`);
}

export async function createAction(params: {
  project_id: string | number;
  name: string;
  description?: string;
  steps?: Record<string, unknown>[];
  tags?: string[];
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = { name: params.name };
  if (params.description !== undefined) payload.description = params.description;
  if (params.steps !== undefined) payload.steps = params.steps;
  if (params.tags !== undefined) payload.tags = params.tags;
  return pPost(`${proj(params.project_id)}/actions/`, payload);
}

export async function updateAction(params: {
  project_id: string | number;
  action_id: string | number;
  name?: string;
  description?: string;
  steps?: Record<string, unknown>[];
  tags?: string[];
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.description !== undefined) payload.description = params.description;
  if (params.steps !== undefined) payload.steps = params.steps;
  if (params.tags !== undefined) payload.tags = params.tags;
  return pPatch(`${proj(params.project_id)}/actions/${enc(params.action_id)}/`, payload);
}

// ---------------------------------------------------------------------------
// SESSION RECORDINGS
// ---------------------------------------------------------------------------
export async function listSessionRecordings(params: {
  project_id: string | number;
  limit?: number;
  offset?: number;
  person_uuid?: string;
  date_from?: string;
  date_to?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.person_uuid !== undefined) qs.set('person_uuid', params.person_uuid);
  if (params.date_from !== undefined) qs.set('date_from', params.date_from);
  if (params.date_to !== undefined) qs.set('date_to', params.date_to);
  const q = qs.toString();
  return pGet(`${proj(params.project_id)}/session_recordings/${q ? '?' + q : ''}`);
}

export async function getSessionRecording(params: {
  project_id: string | number;
  recording_id: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`${proj(params.project_id)}/session_recordings/${enc(params.recording_id)}/`);
}

// ---------------------------------------------------------------------------
// GROUPS
// ---------------------------------------------------------------------------
export async function listGroups(params: {
  project_id: string | number;
  group_type_index: number;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  qs.set('group_type_index', String(params.group_type_index));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  if (params.search !== undefined) qs.set('search', params.search);
  return pGet(`${proj(params.project_id)}/groups/?${qs.toString()}`);
}

export async function getGroup(params: {
  project_id: string | number;
  group_type_index: number;
  group_key: string;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const qs = new URLSearchParams();
  qs.set('group_type_index', String(params.group_type_index));
  qs.set('group_key', params.group_key);
  return pGet(`${proj(params.project_id)}/groups/find/?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// PROJECTS (get/update — list already in api-client.ts)
// ---------------------------------------------------------------------------
export async function getProject(params: {
  project_id: string | number;
}): Promise<any> {
  assertNotPhi(params.project_id);
  return pGet(`/api/projects/${enc(params.project_id)}/`);
}

export async function updateProject(params: {
  project_id: string | number;
  name?: string;
  timezone?: string;
  anonymize_ips?: boolean;
  slack_incoming_webhook?: string;
  completed_snippet_onboarding?: boolean;
}): Promise<any> {
  assertNotPhi(params.project_id);
  const payload: Record<string, unknown> = {};
  if (params.name !== undefined) payload.name = params.name;
  if (params.timezone !== undefined) payload.timezone = params.timezone;
  if (params.anonymize_ips !== undefined) payload.anonymize_ips = params.anonymize_ips;
  if (params.slack_incoming_webhook !== undefined) payload.slack_incoming_webhook = params.slack_incoming_webhook;
  if (params.completed_snippet_onboarding !== undefined) payload.completed_snippet_onboarding = params.completed_snippet_onboarding;
  return pPatch(`/api/projects/${enc(params.project_id)}/`, payload);
}
