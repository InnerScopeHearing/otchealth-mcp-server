/**
 * Sentry Full Client — exhaustive read+write coverage.
 * Self-contained: duplicates auth helpers from api-client.ts so it can be imported
 * by new tool files without touching the existing clients.
 * PHI ring guard: assertNotPhi() / filterPhi() must be called on every project-scoped op.
 */
import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------
export class SentryFullError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'SentryFullError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}

// ---------------------------------------------------------------------------
// PHI guard  (mirrors api-client.ts isPhiProject; redefined here so this file
// is self-contained per the brief requirement)
// ---------------------------------------------------------------------------
export function isPhiProject(slug: string): boolean { return /^medreview/i.test(slug ?? ''); }

function assertNotPhi(projectSlug: string): void {
  if (isPhiProject(projectSlug)) {
    throw new SentryFullError({
      code: 'sentry_phi_blocked',
      status: 403,
      message: `Project "${projectSlug}" is a MedReview PHI project and MUST NOT be accessed via the gateway.`,
      nextStep: 'Use the BAA-covered MedReview engine for PHI project operations.',
    });
  }
}

function filterPhi<T extends { slug?: string }>(items: T[]): T[] {
  return (Array.isArray(items) ? items : []).filter((p) => !isPhiProject(p.slug ?? ''));
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------
function org(): string { return env.SENTRY_ORG || 'otchealth-inc'; }
function base(): string { return 'https://us.sentry.io/api/0'; }

function requireKey(): string {
  if (!env.SENTRY_AUTH_TOKEN) throw new SentryFullError({ code: 'sentry_not_configured', status: 0, message: 'SENTRY_AUTH_TOKEN not set.', nextStep: 'Add SENTRY_AUTH_TOKEN from the vault.' });
  return env.SENTRY_AUTH_TOKEN;
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const key = requireKey();
  const opts: Record<string, any> = { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const { statusCode, body: resBody } = await request(`${base()}${path}`, opts);
  const text = await resBody.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new SentryFullError({ code: `sentry_${statusCode}`, status: statusCode, message: data?.detail ?? `HTTP ${statusCode}`, nextStep: 'Verify SENTRY_AUTH_TOKEN scopes and org/project slug.' });
  return data as T;
}

const GET = <T = any>(path: string) => req<T>('GET', path);
const POST = <T = any>(path: string, body: unknown) => req<T>('POST', path, body);
const PUT = <T = any>(path: string, body: unknown) => req<T>('PUT', path, body);
const DELETE = <T = any>(path: string) => req<T>('DELETE', path);

const O = () => encodeURIComponent(org());
const P = (s: string) => encodeURIComponent(s);

// ===========================================================================
// ISSUES
// ===========================================================================
export async function getIssue(issueId: string, projectSlug: string): Promise<any> {
  assertNotPhi(projectSlug);
  return GET(`/issues/${P(issueId)}/`);
}

export async function deleteIssue(issueId: string, projectSlug: string): Promise<void> {
  assertNotPhi(projectSlug);
  await DELETE(`/issues/${P(issueId)}/`);
}

export async function listEventsForIssue(issueId: string, projectSlug: string, full?: boolean): Promise<any[]> {
  assertNotPhi(projectSlug);
  const qs = full ? '?full=true' : '';
  return GET<any[]>(`/issues/${P(issueId)}/events/${qs}`);
}

export async function listIssueHashes(issueId: string, projectSlug: string): Promise<any[]> {
  assertNotPhi(projectSlug);
  return GET<any[]>(`/issues/${P(issueId)}/hashes/`);
}

export interface UpdateBulkIssuesParams {
  projectSlug: string;
  query: string;
  status?: string;
  assignedTo?: string;
  hasSeen?: boolean;
  isBookmarked?: boolean;
}

export async function updateBulkIssues(params: UpdateBulkIssuesParams): Promise<any> {
  assertNotPhi(params.projectSlug);
  const payload: Record<string, unknown> = {};
  if (params.status !== undefined) payload.status = params.status;
  if (params.assignedTo !== undefined) payload.assignedTo = params.assignedTo;
  if (params.hasSeen !== undefined) payload.hasSeen = params.hasSeen;
  if (params.isBookmarked !== undefined) payload.isBookmarked = params.isBookmarked;
  return PUT(`/projects/${O()}/${P(params.projectSlug)}/issues/?query=${encodeURIComponent(params.query)}`, payload);
}

export async function mergeIssues(projectSlug: string, issueIds: string[]): Promise<any> {
  assertNotPhi(projectSlug);
  const qs = issueIds.map((id) => `id=${encodeURIComponent(id)}`).join('&');
  return PUT(`/projects/${O()}/${P(projectSlug)}/issues/merge/?${qs}`, {});
}

// ===========================================================================
// EVENTS
// ===========================================================================
export async function listEventsForProject(projectSlug: string, full?: boolean): Promise<any[]> {
  assertNotPhi(projectSlug);
  const qs = full ? '?full=true' : '';
  return GET<any[]>(`/projects/${O()}/${P(projectSlug)}/events/${qs}`);
}

export async function getEvent(projectSlug: string, eventId: string): Promise<any> {
  assertNotPhi(projectSlug);
  return GET(`/projects/${O()}/${P(projectSlug)}/events/${P(eventId)}/`);
}

export async function getLatestEventForIssue(issueId: string, projectSlug: string): Promise<any> {
  assertNotPhi(projectSlug);
  return GET(`/issues/${P(issueId)}/events/latest/`);
}

export async function getOldestEventForIssue(issueId: string, projectSlug: string): Promise<any> {
  assertNotPhi(projectSlug);
  return GET(`/issues/${P(issueId)}/events/oldest/`);
}

export async function listTagValues(projectSlug: string, key: string): Promise<any[]> {
  assertNotPhi(projectSlug);
  return GET<any[]>(`/projects/${O()}/${P(projectSlug)}/tags/${P(key)}/values/`);
}

// ===========================================================================
// PROJECTS
// ===========================================================================
export async function getProject(projectSlug: string): Promise<any> {
  assertNotPhi(projectSlug);
  return GET(`/projects/${O()}/${P(projectSlug)}/`);
}

export async function createProject(teamSlug: string, name: string, slug?: string, platform?: string): Promise<any> {
  if (slug && isPhiProject(slug)) throw new SentryFullError({ code: 'sentry_phi_blocked', status: 403, message: `Slug "${slug}" is reserved for PHI (MedReview). Use the BAA-covered engine.`, nextStep: 'Choose a non-medreview slug.' });
  const payload: Record<string, unknown> = { name };
  if (slug) payload.slug = slug;
  if (platform) payload.platform = platform;
  return POST(`/teams/${O()}/${P(teamSlug)}/projects/`, payload);
}

export async function updateProject(projectSlug: string, updates: { name?: string; platform?: string; isBookmarked?: boolean }): Promise<any> {
  assertNotPhi(projectSlug);
  return PUT(`/projects/${O()}/${P(projectSlug)}/`, updates);
}

export async function deleteProject(projectSlug: string): Promise<void> {
  assertNotPhi(projectSlug);
  await DELETE(`/projects/${O()}/${P(projectSlug)}/`);
}

export async function listProjectKeys(projectSlug: string): Promise<any[]> {
  assertNotPhi(projectSlug);
  return GET<any[]>(`/projects/${O()}/${P(projectSlug)}/keys/`);
}

export async function createProjectKey(projectSlug: string, name: string): Promise<any> {
  assertNotPhi(projectSlug);
  return POST(`/projects/${O()}/${P(projectSlug)}/keys/`, { name });
}

export async function listProjectUsers(projectSlug: string): Promise<any[]> {
  assertNotPhi(projectSlug);
  return GET<any[]>(`/projects/${O()}/${P(projectSlug)}/users/`);
}

export async function listProjectTags(projectSlug: string): Promise<any[]> {
  assertNotPhi(projectSlug);
  return GET<any[]>(`/projects/${O()}/${P(projectSlug)}/tags/`);
}

// ===========================================================================
// RELEASES
// ===========================================================================
export async function listReleases(): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/releases/`);
}

export async function getRelease(version: string): Promise<any> {
  return GET(`/organizations/${O()}/releases/${P(version)}/`);
}

export async function updateRelease(version: string, updates: { projects?: string[]; ref?: string; url?: string; dateReleased?: string }): Promise<any> {
  if (updates.projects) {
    for (const s of updates.projects) assertNotPhi(s);
  }
  return PUT(`/organizations/${O()}/releases/${P(version)}/`, updates);
}

export async function deleteRelease(version: string): Promise<void> {
  await DELETE(`/organizations/${O()}/releases/${P(version)}/`);
}

export async function listReleaseDeploys(version: string): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/releases/${P(version)}/deploys/`);
}

export async function createReleaseDeploy(version: string, params: { environment: string; name?: string; url?: string; dateStarted?: string; dateFinished?: string }): Promise<any> {
  return POST(`/organizations/${O()}/releases/${P(version)}/deploys/`, params);
}

export async function listReleaseCommits(version: string): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/releases/${P(version)}/commits/`);
}

export async function listReleaseFiles(version: string): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/releases/${P(version)}/files/`);
}

// ===========================================================================
// TEAMS
// ===========================================================================
export async function listTeams(): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/teams/`);
}

export async function getTeam(teamSlug: string): Promise<any> {
  return GET(`/teams/${O()}/${P(teamSlug)}/`);
}

export async function createTeam(name: string, slug?: string): Promise<any> {
  const payload: Record<string, unknown> = { name };
  if (slug) payload.slug = slug;
  return POST(`/organizations/${O()}/teams/`, payload);
}

export async function updateTeam(teamSlug: string, updates: { name?: string; slug?: string }): Promise<any> {
  return PUT(`/teams/${O()}/${P(teamSlug)}/`, updates);
}

export async function deleteTeam(teamSlug: string): Promise<void> {
  await DELETE(`/teams/${O()}/${P(teamSlug)}/`);
}

export async function listTeamProjects(teamSlug: string): Promise<any[]> {
  const all = await GET<any[]>(`/teams/${O()}/${P(teamSlug)}/projects/`);
  return filterPhi(all);
}

export async function listTeamMembers(teamSlug: string): Promise<any[]> {
  return GET<any[]>(`/teams/${O()}/${P(teamSlug)}/members/`);
}

// ===========================================================================
// MEMBERS
// ===========================================================================
export async function listOrgMembers(): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/members/`);
}

export async function getOrgMember(memberId: string): Promise<any> {
  return GET(`/organizations/${O()}/members/${P(memberId)}/`);
}

// ===========================================================================
// ALERT RULES (metric + issue)
// ===========================================================================
export async function listAlertRules(projectSlug: string): Promise<any[]> {
  assertNotPhi(projectSlug);
  return GET<any[]>(`/projects/${O()}/${P(projectSlug)}/rules/`);
}

export async function getAlertRule(projectSlug: string, ruleId: string): Promise<any> {
  assertNotPhi(projectSlug);
  return GET(`/projects/${O()}/${P(projectSlug)}/rules/${P(ruleId)}/`);
}

export async function createAlertRule(projectSlug: string, rule: { name: string; conditions: unknown[]; filters?: unknown[]; actions: unknown[]; actionMatch?: string; filterMatch?: string; frequency?: number }): Promise<any> {
  assertNotPhi(projectSlug);
  return POST(`/projects/${O()}/${P(projectSlug)}/rules/`, rule);
}

export async function updateAlertRule(projectSlug: string, ruleId: string, updates: Record<string, unknown>): Promise<any> {
  assertNotPhi(projectSlug);
  return PUT(`/projects/${O()}/${P(projectSlug)}/rules/${P(ruleId)}/`, updates);
}

export async function deleteAlertRule(projectSlug: string, ruleId: string): Promise<void> {
  assertNotPhi(projectSlug);
  await DELETE(`/projects/${O()}/${P(projectSlug)}/rules/${P(ruleId)}/`);
}

// ===========================================================================
// MONITORS / CRONS
// ===========================================================================
export async function listMonitors(): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/monitors/`);
}

export async function getMonitor(monitorSlug: string): Promise<any> {
  return GET(`/organizations/${O()}/monitors/${P(monitorSlug)}/`);
}

// ===========================================================================
// TAGS (org-level)
// ===========================================================================
export async function listOrgTags(): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/tags/`);
}

export async function getOrgTagValues(key: string): Promise<any[]> {
  return GET<any[]>(`/organizations/${O()}/tags/${P(key)}/values/`);
}
