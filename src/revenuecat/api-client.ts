import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';
const env = loadEnv();
export class RevenueCatApiError extends Error {
  readonly code: string; readonly status: number; readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) { super(a.message); this.name='RevenueCatApiError'; this.code=a.code; this.status=a.status; this.nextStep=a.nextStep; }
}
function requireKey(): string { if (!env.REVENUECAT_API_KEY) throw new RevenueCatApiError({ code:'revenuecat_not_configured', status:0, message:'REVENUECAT_API_KEY not set.', nextStep:'Add REVENUECAT_API_KEY (sk_) from the vault.' }); return env.REVENUECAT_API_KEY; }
async function rcGet<T=any>(path: string): Promise<T> {
  const key = requireKey();
  // Read-only GET: safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(`https://api.revenuecat.com/v2${path}`, { method:'GET', headers:{ Authorization:`Bearer ${key}` } }, { retries: 1 });
  const statusCode = res.status;
  const text = await res.text(); let data:any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (statusCode >= 400) throw new RevenueCatApiError({ code:`revenuecat_${statusCode}`, status:statusCode, message:data?.message||`HTTP ${statusCode}`, nextStep:'Verify REVENUECAT_API_KEY (v2 secret sk_).' });
  return data as T;
}
export async function listProjects(): Promise<any> { return rcGet('/projects'); }
