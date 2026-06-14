/**
 * PostHog management API client (METADATA ONLY).
 *
 * Base host from POSTHOG_HOST (default https://us.posthog.com). Auth is a
 * personal API key (starts with phx_) sent as `Authorization: Bearer <key>`.
 *
 * ============================ PHI CARVE-OUT (BAA, ABSOLUTE) ============================
 * MedReview's PostHog project (468398) is PHI-hardened: session replay, console
 * capture, and autocapture are OFF and ip-anonymization is ON, and it is only
 * instrumented from the BAA environment. This gateway is the NON-PHI ring.
 *
 * Therefore this client and its tools expose PROJECT / INSIGHT / FEATURE-FLAG /
 * EXPERIMENT / ANNOTATION / COHORT METADATA ONLY. There is intentionally NO
 * method here for:
 *   - session recordings / replays  (/api/projects/:id/session_recordings)
 *   - person-level event data        (/api/projects/:id/events, /persons, /query)
 *   - any endpoint that returns raw event rows or per-person properties.
 * Adding any such method would let MedReview PHI (and any non-PHI app's
 * person-level data) leak through the non-PHI gateway. Do NOT add them here.
 * A list endpoint returning all projects is fine: that is metadata. Even for the
 * MedReview project, only its name/id/config-shape metadata is ever returned.
 * =====================================================================================
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

export class PostHogApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'PostHogApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireKey(): string {
  if (!env.POSTHOG_PERSONAL_API_KEY) {
    throw new PostHogApiError({
      code: 'posthog_not_configured',
      status: 0,
      message: 'PostHog integration is not configured (set POSTHOG_PERSONAL_API_KEY).',
      nextStep:
        'Set POSTHOG_PERSONAL_API_KEY (a phx_ personal API key) in the deployment env vars. Create it in PostHog -> Settings -> Personal API keys; the value lives in Matt\'s Notion Token Vault under the PostHog section.',
    });
  }
  return env.POSTHOG_PERSONAL_API_KEY;
}

/**
 * Validate + encode a value used as a URL PATH SEGMENT (project/insight/flag id).
 * PostHog ids are numeric or short_id slugs, so we allow only [A-Za-z0-9_-] and
 * encode the result. This prevents path traversal / request-forgery: a crafted id
 * cannot inject `/`, `?`, `#`, `@`, or `..` into the request URL.
 */
function seg(value: string | number): string {
  const s = String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new PostHogApiError({
      code: 'posthog_invalid_id',
      status: 0,
      message: `Invalid PostHog resource id "${s}". Ids must be alphanumeric (with _ or -), 1-64 chars.`,
      nextStep: 'Pass a numeric project/insight/flag id, or a valid short_id slug (use posthog_list_projects to find ids).',
    });
  }
  return encodeURIComponent(s);
}

function buildQuery(q?: Record<string, string | number | boolean | undefined>): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export interface PostHogGetOptions {
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  correlationId?: string;
}

export async function posthogGet<T = unknown>(path: string, opts: PostHogGetOptions = {}): Promise<T> {
  const key = requireKey();
  const base = env.POSTHOG_HOST.replace(/\/$/, '');
  const url = `${base}${path}${buildQuery(opts.query)}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const body = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.debug(
        { type: 'posthog_ok', path, status: res.statusCode, latency_ms: latency, correlation_id: opts.correlationId },
        'posthog ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, body);
  } catch (err) {
    if (err instanceof PostHogApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      {
        type: 'posthog_network_error',
        path,
        latency_ms: latency,
        correlation_id: opts.correlationId,
        err: (err as Error).message,
      },
      'posthog network error',
    );
    throw new PostHogApiError({
      code: 'posthog_network_error',
      status: 0,
      message: `Network error calling PostHog API at ${path}: ${(err as Error).message}`,
      nextStep: 'Check the deployment logs and PostHog status (https://status.posthog.com/). Retry if transient.',
      upstream: err,
    });
  }
}

function mapError(status: number, path: string, body: string): PostHogApiError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep raw string */ }
  if (status === 401 || status === 403) {
    return new PostHogApiError({
      code: 'posthog_auth_failed',
      status,
      message: `PostHog rejected auth on ${path}.`,
      nextStep:
        'Confirm POSTHOG_PERSONAL_API_KEY matches the Notion vault value and its scopes cover this resource (read scope on project/insight/flag/experiment/annotation/cohort). Rotate if leaked.',
      upstream,
    });
  }
  if (status === 404) {
    return new PostHogApiError({
      code: 'posthog_not_found',
      status,
      message: `PostHog returned 404 for ${path}.`,
      nextStep: 'Verify the project / resource id. Use posthog_list_projects to find valid project ids.',
      upstream,
    });
  }
  if (status === 429) {
    return new PostHogApiError({
      code: 'posthog_rate_limited',
      status,
      message: 'PostHog rate-limited the call.',
      nextStep: 'Back off and retry. PostHog management API has per-key rate limits.',
      upstream,
    });
  }
  return new PostHogApiError({
    code: status >= 500 ? 'posthog_upstream_error' : 'posthog_request_error',
    status,
    message: `PostHog returned ${status} for ${path}.`,
    nextStep: status >= 500 ? 'Check https://status.posthog.com/ and retry.' : 'Verify input parameters against the PostHog API docs (https://posthog.com/docs/api).',
    upstream,
  });
}

/* ===================== Loose paginated shape ===================== */

export interface PostHogPaginated<T> {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: T[];
}

/* ===================== Typed metadata methods ===================== */

/** List organizations the key can see. GET /api/organizations/ */
export async function listOrganizations(opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>('/api/organizations/', opts);
}

/** List projects. GET /api/projects/ (metadata: id, name, config flags). */
export async function listProjects(opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>('/api/projects/', opts);
}

/** List insights (funnels, trends, etc.) for a project. GET /api/projects/:id/insights/ */
export async function listInsights(projectId: string | number, opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>(`/api/projects/${seg(projectId)}/insights/`, opts);
}

/** Get a single insight (definition + last refresh metadata). GET /api/projects/:id/insights/:insightId/ */
export async function getInsight(projectId: string | number, insightId: string | number, opts: PostHogGetOptions = {}): Promise<unknown> {
  return posthogGet<unknown>(`/api/projects/${seg(projectId)}/insights/${seg(insightId)}/`, opts);
}

/** List feature flags. GET /api/projects/:id/feature_flags/ */
export async function listFeatureFlags(projectId: string | number, opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>(`/api/projects/${seg(projectId)}/feature_flags/`, opts);
}

/** Get a single feature flag. GET /api/projects/:id/feature_flags/:flagId/ */
export async function getFeatureFlag(projectId: string | number, flagId: string | number, opts: PostHogGetOptions = {}): Promise<unknown> {
  return posthogGet<unknown>(`/api/projects/${seg(projectId)}/feature_flags/${seg(flagId)}/`, opts);
}

/** List experiments. GET /api/projects/:id/experiments/ */
export async function listExperiments(projectId: string | number, opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>(`/api/projects/${seg(projectId)}/experiments/`, opts);
}

/** List annotations. GET /api/projects/:id/annotations/ */
export async function listAnnotations(projectId: string | number, opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>(`/api/projects/${seg(projectId)}/annotations/`, opts);
}

/**
 * List cohorts (cohort DEFINITIONS only, metadata). GET /api/projects/:id/cohorts/
 * NOTE: this never reads cohort MEMBERSHIP (the persons in a cohort) which would
 * be person-level data. Definitions are metadata; members are not exposed here.
 */
export async function listCohorts(projectId: string | number, opts: PostHogGetOptions = {}): Promise<PostHogPaginated<unknown>> {
  return posthogGet<PostHogPaginated<unknown>>(`/api/projects/${seg(projectId)}/cohorts/`, opts);
}
