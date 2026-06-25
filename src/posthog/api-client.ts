import { request } from 'undici';
import { loadEnv } from '../config/env.js';
const env = loadEnv();
export class PostHogApiError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'PostHogApiError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}
function host(): string { return env.POSTHOG_HOST || 'https://us.posthog.com'; }
function requireKey(): string {
  if (!env.POSTHOG_PERSONAL_API_KEY) throw new PostHogApiError({ code: 'posthog_not_configured', status: 0, message: 'POSTHOG_PERSONAL_API_KEY not set.', nextStep: 'Add POSTHOG_PERSONAL_API_KEY from the vault.' });
  return env.POSTHOG_PERSONAL_API_KEY;
}
// PHI ring guard: MedReview PostHog project id 468398 is PHI and MUST NEVER be exposed via the gateway.
export function isPhiProject(id: string | number): boolean { return String(id) === '468398'; }
export async function listProjects(): Promise<any[]> {
  const key = requireKey();
  const { statusCode, body } = await request(`${host()}/api/organizations/@current/projects/`, { method: 'GET', headers: { Authorization: `Bearer ${key}` } });
  const text = await body.text(); let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new PostHogApiError({ code: `posthog_${statusCode}`, status: statusCode, message: data?.detail || data?.message || `HTTP ${statusCode}`, nextStep: 'Verify POSTHOG_PERSONAL_API_KEY scope.' });
  const results: any[] = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : []);
  return results.filter((p) => !isPhiProject(p.id)); // carve out PHI project 468398
}
