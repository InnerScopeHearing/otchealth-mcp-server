/**
 * Netlify write-client — deploy trigger, env-var management, and deploy hooks.
 *
 * Auth is identical to the read api-client: Bearer NETLIFY_AUTH_TOKEN.
 * Base URL: https://api.netlify.com/api/v1
 *
 * Operations:
 *   - triggerDeploy      — POST /sites/{id}/builds (kick off a new build from repo)
 *   - setEnvVar          — POST /accounts/{account_id}/env  (create/update site env var)
 *   - createDeployHook   — POST /sites/{id}/build_hooks     (create a webhook URL that triggers a build)
 */

import { loadEnv } from '../config/env.js';
import { fetchWithBudget } from '../util/fetch-budget.js';

const env = loadEnv();

// ── Error class (mirrors NetlifyApiError shape) ───────────────────────────────

export class NetlifyWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(a: {
    code: string;
    status: number;
    message: string;
    nextStep: string;
    upstream?: unknown;
  }) {
    super(a.message);
    this.name = 'NetlifyWriteError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
    this.upstream = a.upstream;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireKey(): string {
  if (!env.NETLIFY_AUTH_TOKEN)
    throw new NetlifyWriteError({
      code: 'netlify_not_configured',
      status: 0,
      message: 'NETLIFY_AUTH_TOKEN is not set.',
      nextStep: 'Add NETLIFY_AUTH_TOKEN to the MCP server environment from the Notion API Vault.',
    });
  return env.NETLIFY_AUTH_TOKEN;
}

const BASE = 'https://api.netlify.com/api/v1';

// ── Core HTTP helper ──────────────────────────────────────────────────────────

async function netlifyWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ statusCode: number; data: T }> {
  const key = requireKey();
  // Every call through netlifyWrite() is a non-idempotent mutation (trigger a build,
  // set an env var, create a deploy hook): retries:0 so a timeout never causes a
  // duplicate deploy trigger or env-var write.
  const res = await fetchWithBudget(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, { retries: 0 });
  const statusCode = res.status;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text ? { raw: text } : null; }
  if (statusCode >= 400)
    throw new NetlifyWriteError({
      code: `netlify_${statusCode}`,
      status: statusCode,
      message: data?.message ?? data?.error ?? `HTTP ${statusCode}`,
      nextStep: 'Check the Netlify API response. Ensure NETLIFY_AUTH_TOKEN is valid and the site_id/account_id are correct.',
      upstream: data,
    });
  return { statusCode, data: data as T };
}

// ── Write operations ──────────────────────────────────────────────────────────

/**
 * Trigger a new build for a Netlify site from its linked repository.
 * Optionally specify a branch or clear the build cache.
 *
 * Maps to: POST /api/v1/sites/{site_id}/builds
 */
export async function triggerDeploy(opts: {
  siteId: string;
  branch?: string;
  clearCache?: boolean;
}): Promise<{ id: string; deployId?: string; done: boolean; sha?: string; createdAt?: string }> {
  const body: Record<string, unknown> = {};
  if (opts.branch) body.branch = opts.branch;
  if (opts.clearCache) body.clear_cache = true;

  const { data } = await netlifyWrite<any>('POST', `/sites/${encodeURIComponent(opts.siteId)}/builds`, body);
  return {
    id: data.id ?? '',
    deployId: data.deploy_id,
    done: data.done === true,
    sha: data.sha,
    createdAt: data.created_at,
  };
}

/**
 * Create or update a site-scoped environment variable.
 *
 * The Netlify env API works at the account level; pass `accountId` (slug or UUID)
 * and optionally `siteId` as a query parameter to scope the variable to a single site.
 *
 * Maps to: POST /api/v1/accounts/{account_id}/env?site_id={site_id}
 *
 * `context` defaults to "all". Available contexts: all, dev, branch-deploy, deploy-preview, production.
 * `scopes` defaults to ["builds","functions","runtime","post-processing"].
 */
export async function setEnvVar(opts: {
  accountId: string;
  key: string;
  value: string;
  context?: string;
  scopes?: string[];
  siteId?: string;
}): Promise<{ key: string; context: string; scopes: string[] }> {
  const context = opts.context ?? 'all';
  const scopes = opts.scopes ?? ['builds', 'functions', 'runtime', 'post-processing'];

  const qs = opts.siteId ? `?site_id=${encodeURIComponent(opts.siteId)}` : '';
  const body = [
    {
      key: opts.key,
      scopes,
      values: [{ context, value: opts.value }],
    },
  ];

  await netlifyWrite('POST', `/accounts/${encodeURIComponent(opts.accountId)}/env${qs}`, body);
  return { key: opts.key, context, scopes };
}

/**
 * Create a deploy hook (webhook URL) for a Netlify site.
 * POSTing to the returned URL later triggers a new build.
 *
 * Maps to: POST /api/v1/sites/{site_id}/build_hooks
 */
export async function createDeployHook(opts: {
  siteId: string;
  title: string;
  branch?: string;
}): Promise<{ id: string; title: string; branch: string; url: string; createdAt?: string }> {
  const body: Record<string, unknown> = { title: opts.title };
  if (opts.branch) body.branch = opts.branch;

  const { data } = await netlifyWrite<any>('POST', `/sites/${encodeURIComponent(opts.siteId)}/build_hooks`, body);
  return {
    id: data.id ?? '',
    title: data.title ?? opts.title,
    branch: data.branch ?? opts.branch ?? 'main',
    url: data.url ?? '',
    createdAt: data.created_at,
  };
}
