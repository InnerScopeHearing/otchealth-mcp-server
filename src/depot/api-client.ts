import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
const env = loadEnv();
export class DepotApiError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message); this.name = 'DepotApiError'; this.code = a.code; this.status = a.status; this.nextStep = a.nextStep;
  }
}
function base(): string { return 'https://api.depot.dev'; }
function requireToken(): string {
  if (!env.DEPOT_TOKEN) throw new DepotApiError({ code: 'depot_not_configured', status: 0, message: 'DEPOT_TOKEN not set.', nextStep: 'Add DEPOT_TOKEN from the vault.' });
  return env.DEPOT_TOKEN;
}
export async function listProjects(): Promise<{ projectId: string; name: string }[]> {
  const token = requireToken();
  // Connect RPC is POST-only by convention, but ListProjects is a read: safe to retry
  // once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(`${base()}/depot.core.v1.ProjectService/ListProjects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new DepotApiError({ code: `depot_${statusCode}`, status: statusCode, message: data?.message || data?.detail || `HTTP ${statusCode}`, nextStep: 'Verify DEPOT_TOKEN is valid and has project read access.' });
  // Tolerate both `projects` and `result` envelope keys.
  const projects = data?.projects ?? data?.result ?? [];
  return Array.isArray(projects) ? projects : [];
}
