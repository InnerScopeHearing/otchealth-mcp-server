import { request } from 'undici';
import { loadEnv } from '../config/env.js';
const env = loadEnv();
export class SentryApiError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'SentryApiError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}
function org(): string { return env.SENTRY_ORG || 'otchealth-inc'; }
function base(): string { return 'https://us.sentry.io/api/0'; }
function requireKey(): string {
  if (!env.SENTRY_AUTH_TOKEN) throw new SentryApiError({ code: 'sentry_not_configured', status: 0, message: 'SENTRY_AUTH_TOKEN not set.', nextStep: 'Add SENTRY_AUTH_TOKEN from the vault.' });
  return env.SENTRY_AUTH_TOKEN;
}
// PHI ring guard: MedReview Sentry projects are PHI and MUST NEVER be exposed via the gateway.
export function isPhiProject(slug: string): boolean { return /^medreview/i.test(slug || ''); }
async function sentryGet<T = any>(path: string): Promise<T> {
  const key = requireKey();
  const { statusCode, body } = await request(`${base()}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${key}` } });
  const text = await body.text(); let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new SentryApiError({ code: `sentry_${statusCode}`, status: statusCode, message: data?.detail || `HTTP ${statusCode}`, nextStep: 'Verify SENTRY_AUTH_TOKEN scope + org slug.' });
  return data as T;
}
export async function listProjects(): Promise<any[]> {
  const all = await sentryGet<any[]>(`/organizations/${encodeURIComponent(org())}/projects/`);
  return (Array.isArray(all) ? all : []).filter((p) => !isPhiProject(p.slug)); // carve out PHI
}
export async function listIssues(projectSlug: string, statsPeriod = '14d'): Promise<any[]> {
  if (isPhiProject(projectSlug)) throw new SentryApiError({ code: 'sentry_phi_blocked', status: 403, message: `Project "${projectSlug}" is PHI (MedReview) and not accessible via the gateway.`, nextStep: 'Use the BAA-covered engine for MedReview.' });
  return sentryGet<any[]>(`/projects/${encodeURIComponent(org())}/${encodeURIComponent(projectSlug)}/issues/?query=is:unresolved&statsPeriod=${encodeURIComponent(statsPeriod)}`);
}
