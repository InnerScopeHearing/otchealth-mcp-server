/**
 * Netlify full-client — exhaustive CRUD coverage for OTCHealth MCP gateway.
 *
 * Auth: Bearer NETLIFY_AUTH_TOKEN (same as api-client.ts + write-client.ts).
 * Base: https://api.netlify.com/api/v1
 *
 * Resources:
 *   Sites          — get, create, update, delete
 *   Deploys        — get, lock, unlock, restore/rollback, cancel, list-by-site
 *   Env vars       — list, get, update, delete, get-by-key
 *   Build hooks    — list, get, update, delete
 *   DNS zones      — list, get, create, delete
 *   DNS records    — list, create, delete
 *   Forms          — list, get, delete
 *   Form submissions — list, delete
 *   Snippets       — list, create, update, delete
 *   Deploy keys    — list, create, delete
 *   Functions      — list per site
 *   Site files     — list
 *   Members / accounts — list accounts
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

// ── Error class ────────────────────────────────────────────────────────────────

export class NetlifyFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(a: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(a.message);
    this.name = 'NetlifyFullError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
    this.upstream = a.upstream;
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────────

function requireKey(): string {
  if (!env.NETLIFY_AUTH_TOKEN)
    throw new NetlifyFullError({
      code: 'netlify_not_configured',
      status: 0,
      message: 'NETLIFY_AUTH_TOKEN is not set.',
      nextStep: 'Add NETLIFY_AUTH_TOKEN to the MCP server environment from the Notion API Vault.',
    });
  return env.NETLIFY_AUTH_TOKEN;
}

const BASE = 'https://api.netlify.com/api/v1';

// ── Core HTTP helpers ──────────────────────────────────────────────────────────

async function netlifyFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
): Promise<T> {
  const key = requireKey();
  let url = `${BASE}${path}`;
  if (opts?.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const { statusCode, body: rb } = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await rb.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text ? { raw: text } : null; }

  if (statusCode >= 400) {
    throw new NetlifyFullError({
      code: `netlify_${statusCode}`,
      status: statusCode,
      message: data?.message ?? data?.error ?? `HTTP ${statusCode}`,
      nextStep: 'Check Netlify API response. Verify NETLIFY_AUTH_TOKEN scope and resource IDs.',
      upstream: data,
    });
  }
  return data as T;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SITES
// ═══════════════════════════════════════════════════════════════════════════════

export async function getSite(siteId: string): Promise<any> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}`);
}

export async function createSite(opts: {
  name?: string;
  custom_domain?: string;
  repo?: { provider: string; id: number; branch: string; cmd?: string; dir?: string };
  account_slug?: string;
}): Promise<any> {
  const { account_slug, ...body } = opts;
  const query = account_slug ? { account_slug } : undefined;
  return netlifyFetch('POST', '/sites', { query, body });
}

export async function updateSite(siteId: string, patch: {
  name?: string;
  custom_domain?: string;
  branch_deploy_custom_domain?: string;
  deploy_preview_custom_domain?: string;
  password?: string;
  force_ssl?: boolean;
  prerender?: string;
  processing_settings?: Record<string, unknown>;
  build_settings?: Record<string, unknown>;
  managed_dns?: boolean;
}): Promise<any> {
  return netlifyFetch('PATCH', `/sites/${encodeURIComponent(siteId)}`, { body: patch });
}

export async function deleteSite(siteId: string): Promise<void> {
  await netlifyFetch('DELETE', `/sites/${encodeURIComponent(siteId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLOYS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getDeploy(deployId: string): Promise<any> {
  return netlifyFetch('GET', `/deploys/${encodeURIComponent(deployId)}`);
}

export async function lockDeploy(deployId: string): Promise<any> {
  return netlifyFetch('POST', `/deploys/${encodeURIComponent(deployId)}/lock`);
}

export async function unlockDeploy(deployId: string): Promise<any> {
  return netlifyFetch('POST', `/deploys/${encodeURIComponent(deployId)}/unlock`);
}

/**
 * Restore (rollback) a site to a previously published deploy.
 * POST /sites/{site_id}/deploys/{deploy_id}/restore
 */
export async function restoreDeploy(siteId: string, deployId: string): Promise<any> {
  return netlifyFetch('POST', `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/restore`);
}

/**
 * Cancel a running deploy.
 * POST /deploys/{deploy_id}/cancel
 */
export async function cancelDeploy(deployId: string): Promise<any> {
  return netlifyFetch('POST', `/deploys/${encodeURIComponent(deployId)}/cancel`);
}

export async function listSiteDeploysFull(siteId: string, opts?: {
  per_page?: number;
  page?: number;
  branch?: string;
  state?: string;
}): Promise<any[]> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/deploys`, { query: opts as any });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENV VARS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listEnvVars(accountId: string, opts?: {
  site_id?: string;
  context_name?: string;
  scope?: string;
}): Promise<any[]> {
  return netlifyFetch('GET', `/accounts/${encodeURIComponent(accountId)}/env`, { query: opts as any });
}

export async function getEnvVar(accountId: string, key: string, opts?: { site_id?: string }): Promise<any> {
  return netlifyFetch('GET', `/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`, { query: opts as any });
}

export async function updateEnvVar(accountId: string, key: string, body: {
  key?: string;
  scopes?: string[];
  values?: Array<{ context: string; value: string }>;
  is_secret?: boolean;
  site_id?: string;
}): Promise<any> {
  const { site_id, ...rest } = body;
  const query = site_id ? { site_id } : undefined;
  return netlifyFetch('PUT', `/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`, { query, body: rest });
}

export async function deleteEnvVar(accountId: string, key: string, opts?: { site_id?: string }): Promise<void> {
  await netlifyFetch('DELETE', `/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}`, { query: opts as any });
}

export async function deleteEnvVarValue(accountId: string, key: string, valueId: string, opts?: { site_id?: string }): Promise<void> {
  await netlifyFetch('DELETE', `/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(key)}/value/${encodeURIComponent(valueId)}`, { query: opts as any });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listBuildHooks(siteId: string): Promise<any[]> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/build_hooks`);
}

export async function getBuildHook(siteId: string, hookId: string): Promise<any> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/build_hooks/${encodeURIComponent(hookId)}`);
}

export async function updateBuildHook(siteId: string, hookId: string, patch: {
  title?: string;
  branch?: string;
}): Promise<any> {
  return netlifyFetch('PUT', `/sites/${encodeURIComponent(siteId)}/build_hooks/${encodeURIComponent(hookId)}`, { body: patch });
}

export async function deleteBuildHook(siteId: string, hookId: string): Promise<void> {
  await netlifyFetch('DELETE', `/sites/${encodeURIComponent(siteId)}/build_hooks/${encodeURIComponent(hookId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DNS ZONES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listDnsZones(opts?: { account_slug?: string }): Promise<any[]> {
  return netlifyFetch('GET', '/dns_zones', { query: opts as any });
}

export async function getDnsZone(zoneId: string): Promise<any> {
  return netlifyFetch('GET', `/dns_zones/${encodeURIComponent(zoneId)}`);
}

export async function createDnsZone(opts: {
  name: string;
  account_slug?: string;
  site_id?: string;
}): Promise<any> {
  return netlifyFetch('POST', '/dns_zones', { body: opts });
}

export async function deleteDnsZone(zoneId: string): Promise<void> {
  await netlifyFetch('DELETE', `/dns_zones/${encodeURIComponent(zoneId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DNS RECORDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listDnsRecords(zoneId: string): Promise<any[]> {
  return netlifyFetch('GET', `/dns_zones/${encodeURIComponent(zoneId)}/dns_records`);
}

export async function createDnsRecord(zoneId: string, record: {
  type: string;
  hostname: string;
  value: string;
  ttl?: number;
  priority?: number;
  weight?: number;
  port?: number;
  flag?: number;
  tag?: string;
}): Promise<any> {
  return netlifyFetch('POST', `/dns_zones/${encodeURIComponent(zoneId)}/dns_records`, { body: record });
}

export async function deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
  await netlifyFetch('DELETE', `/dns_zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORMS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listForms(siteId?: string): Promise<any[]> {
  if (siteId) return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/forms`);
  return netlifyFetch('GET', '/forms');
}

export async function getForm(formId: string): Promise<any> {
  return netlifyFetch('GET', `/forms/${encodeURIComponent(formId)}`);
}

export async function deleteForm(formId: string): Promise<void> {
  await netlifyFetch('DELETE', `/forms/${encodeURIComponent(formId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FORM SUBMISSIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listFormSubmissions(formId: string, opts?: {
  per_page?: number;
  page?: number;
  after?: string;
  before?: string;
}): Promise<any[]> {
  return netlifyFetch('GET', `/forms/${encodeURIComponent(formId)}/submissions`, { query: opts as any });
}

export async function listSiteSubmissions(siteId: string, opts?: {
  per_page?: number;
  page?: number;
}): Promise<any[]> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/submissions`, { query: opts as any });
}

export async function deleteFormSubmission(submissionId: string): Promise<void> {
  await netlifyFetch('DELETE', `/submissions/${encodeURIComponent(submissionId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPPETS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listSnippets(siteId: string): Promise<any[]> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/snippets`);
}

export async function createSnippet(siteId: string, snippet: {
  general?: string;
  general_position?: string;
  goal?: string;
  goal_position?: string;
  title: string;
}): Promise<any> {
  return netlifyFetch('POST', `/sites/${encodeURIComponent(siteId)}/snippets`, { body: snippet });
}

export async function getSnippet(siteId: string, snippetId: string): Promise<any> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/snippets/${encodeURIComponent(snippetId)}`);
}

export async function updateSnippet(siteId: string, snippetId: string, patch: {
  general?: string;
  general_position?: string;
  goal?: string;
  goal_position?: string;
  title?: string;
}): Promise<any> {
  return netlifyFetch('PUT', `/sites/${encodeURIComponent(siteId)}/snippets/${encodeURIComponent(snippetId)}`, { body: patch });
}

export async function deleteSnippet(siteId: string, snippetId: string): Promise<void> {
  await netlifyFetch('DELETE', `/sites/${encodeURIComponent(siteId)}/snippets/${encodeURIComponent(snippetId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEPLOY KEYS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listDeployKeys(): Promise<any[]> {
  return netlifyFetch('GET', '/deploy_keys');
}

export async function createDeployKey(): Promise<any> {
  return netlifyFetch('POST', '/deploy_keys');
}

export async function deleteDeployKey(keyId: string): Promise<void> {
  await netlifyFetch('DELETE', `/deploy_keys/${encodeURIComponent(keyId)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export async function listSiteFunctions(siteId: string): Promise<any[]> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/functions`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SITE FILES
// ═══════════════════════════════════════════════════════════════════════════════

export async function listSiteFiles(siteId: string): Promise<any[]> {
  return netlifyFetch('GET', `/sites/${encodeURIComponent(siteId)}/files`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNTS (members)
// ═══════════════════════════════════════════════════════════════════════════════

export async function listAccounts(): Promise<any[]> {
  return netlifyFetch('GET', '/accounts');
}

export async function listAccountMembers(accountId: string): Promise<any[]> {
  return netlifyFetch('GET', `/accounts/${encodeURIComponent(accountId)}/members`);
}
