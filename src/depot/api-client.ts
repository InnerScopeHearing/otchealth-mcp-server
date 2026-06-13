/**
 * Depot API client (FULL API surface, not just grant-burn monitoring).
 *
 * Depot's public API (https://depot.dev/docs/api) is a Connect-RPC API: each
 * method is an HTTP POST to `${BASE}/<package>.<Service>/<Method>` with a JSON
 * body and a JSON response. Auth is `Authorization: Bearer <DEPOT_TOKEN>`.
 * Base host is https://api.depot.dev (overridable via DEPOT_BASE_URL).
 *
 * Connect-RPC over HTTP/JSON returns HTTP 200 on success with a JSON body, and a
 * non-2xx status with `{ code, message }` on failure (Connect error envelope).
 *
 * VERIFIED-STABLE RPC paths (documented + in the depot-go / @depot/sdk clients):
 *   - depot.core.v1.ProjectService/ListProjects
 *   - depot.core.v1.ProjectService/GetProject
 *   - depot.build.v1.BuildService/ListBuilds
 *   - depot.build.v1.BuildService/GetBuild
 *
 * LESS-CERTAIN RPC paths (org usage / grant burn, cache list/usage/reset). The
 * Depot API has these capabilities but the exact RPC method names move; each
 * method below documents the assumed path and is exercised defensively. If a
 * path 404s / returns Connect "unimplemented", the tool surfaces a clear error
 * pointing here rather than silently returning empty. See the TODO markers.
 *
 * Matt directive: know the whole tool, leave no features on the table. So we
 * wire the full surface and flag the unverifiable RPC names instead of dropping
 * the capability.
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

export class DepotApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'DepotApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

function requireToken(): string {
  if (!env.DEPOT_TOKEN) {
    throw new DepotApiError({
      code: 'depot_not_configured',
      status: 0,
      message: 'Depot integration is not configured (set DEPOT_TOKEN).',
      nextStep:
        'Set DEPOT_TOKEN in the deployment env vars. Generate a Depot org/user API token in the Depot dashboard (Settings -> API tokens); the value lives in Matt\'s Notion Token Vault under the Depot section.',
    });
  }
  return env.DEPOT_TOKEN;
}

export interface DepotRpcOptions {
  timeoutMs?: number;
  correlationId?: string;
}

/**
 * Call a Depot Connect-RPC method. `rpcPath` is `<package>.<Service>/<Method>`.
 * Returns the parsed JSON response body (or {} on an empty 2xx).
 */
export async function depotRpc<T = unknown>(
  rpcPath: string,
  body: Record<string, unknown> = {},
  opts: DepotRpcOptions = {},
): Promise<T> {
  const token = requireToken();
  const base = env.DEPOT_BASE_URL.replace(/\/$/, '');
  const url = `${base}/${rpcPath}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      bodyTimeout: opts.timeoutMs ?? 30_000,
      headersTimeout: opts.timeoutMs ?? 30_000,
    });
    const text = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.debug(
        { type: 'depot_rpc_ok', rpc: rpcPath, status: res.statusCode, latency_ms: latency, correlation_id: opts.correlationId },
        'depot rpc ok',
      );
      return text ? (JSON.parse(text) as T) : ({} as T);
    }
    throw mapError(res.statusCode, rpcPath, text);
  } catch (err) {
    if (err instanceof DepotApiError) throw err;
    const latency = Date.now() - started;
    logger.error(
      {
        type: 'depot_rpc_network_error',
        rpc: rpcPath,
        latency_ms: latency,
        correlation_id: opts.correlationId,
        err: (err as Error).message,
      },
      'depot network error',
    );
    throw new DepotApiError({
      code: 'depot_network_error',
      status: 0,
      message: `Network error calling Depot API ${rpcPath}: ${(err as Error).message}`,
      nextStep: 'Check the deployment logs and Depot status (https://status.depot.dev/). Retry if transient.',
      upstream: err,
    });
  }
}

function mapError(status: number, rpcPath: string, body: string): DepotApiError {
  let upstream: unknown = body;
  let connectCode: string | undefined;
  let connectMessage: string | undefined;
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    upstream = parsed;
    connectCode = parsed.code;
    connectMessage = parsed.message;
  } catch {
    /* keep raw string */
  }
  if (status === 401 || status === 403 || connectCode === 'unauthenticated' || connectCode === 'permission_denied') {
    return new DepotApiError({
      code: 'depot_auth_failed',
      status,
      message: `Depot rejected auth on ${rpcPath}${connectMessage ? `: ${connectMessage}` : ''}.`,
      nextStep: 'Confirm DEPOT_TOKEN matches the Notion vault value and has org access. Rotate if leaked.',
      upstream,
    });
  }
  if (status === 404 || connectCode === 'not_found') {
    return new DepotApiError({
      code: 'depot_not_found',
      status,
      message: `Depot returned not-found for ${rpcPath}${connectMessage ? `: ${connectMessage}` : ''}.`,
      nextStep: 'Verify the id exists. Use depot_list_projects / depot_list_builds to find valid ids.',
      upstream,
    });
  }
  if (connectCode === 'unimplemented' || status === 501) {
    return new DepotApiError({
      code: 'depot_rpc_unimplemented',
      status,
      message: `Depot reports RPC ${rpcPath} is unimplemented. The wired method path may be stale.`,
      nextStep:
        'Re-verify the exact Connect-RPC method name against https://depot.dev/docs/api and update src/depot/api-client.ts. See the TODO markers there.',
      upstream,
    });
  }
  if (status === 429 || connectCode === 'resource_exhausted') {
    return new DepotApiError({
      code: 'depot_rate_limited',
      status,
      message: 'Depot rate-limited the call.',
      nextStep: 'Back off a few seconds and retry.',
      upstream,
    });
  }
  if (status >= 500 || connectCode === 'internal' || connectCode === 'unavailable') {
    return new DepotApiError({
      code: 'depot_upstream_error',
      status,
      message: `Depot returned ${status} for ${rpcPath}${connectMessage ? `: ${connectMessage}` : ''}.`,
      nextStep: 'Depot upstream error. Check https://status.depot.dev/ and retry shortly.',
      upstream,
    });
  }
  return new DepotApiError({
    code: 'depot_request_error',
    status,
    message: `Depot returned ${status} for ${rpcPath}${connectMessage ? `: ${connectMessage}` : ''}.`,
    nextStep: 'Verify the request body matches the Depot API docs (https://depot.dev/docs/api).',
    upstream,
  });
}

function effectiveProjectId(explicit?: string): string {
  const id = explicit || env.DEPOT_PROJECT_ID;
  if (!id) {
    throw new DepotApiError({
      code: 'depot_project_required',
      status: 0,
      message: 'No Depot project id provided and DEPOT_PROJECT_ID is unset.',
      nextStep: 'Pass project_id, or set DEPOT_PROJECT_ID in env. Use depot_list_projects to find ids.',
    });
  }
  return id;
}

/* ===================== Typed response shapes (loose, upstream-tolerant) ===================== */

export interface DepotProject {
  projectId?: string;
  name?: string;
  organizationId?: string;
  regionId?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface DepotBuild {
  buildId?: string;
  projectId?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  [k: string]: unknown;
}

/* ===================== High-level typed methods ===================== */

/** List projects in the org. RPC: depot.core.v1.ProjectService/ListProjects (verified-stable). */
export async function listProjects(opts: DepotRpcOptions = {}): Promise<{ projects: DepotProject[] }> {
  const res = await depotRpc<{ projects?: DepotProject[] }>('depot.core.v1.ProjectService/ListProjects', {}, opts);
  return { projects: res.projects ?? [] };
}

/** Get a single project. RPC: depot.core.v1.ProjectService/GetProject (verified-stable). */
export async function getProject(projectId: string, opts: DepotRpcOptions = {}): Promise<{ project: DepotProject | null }> {
  const res = await depotRpc<{ project?: DepotProject }>(
    'depot.core.v1.ProjectService/GetProject',
    { projectId },
    opts,
  );
  return { project: res.project ?? null };
}

/**
 * List builds, optionally scoped to a project and filtered by status.
 * RPC: depot.build.v1.BuildService/ListBuilds (verified-stable).
 */
export async function listBuilds(
  args: { projectId?: string; status?: string; pageSize?: number; pageToken?: string },
  opts: DepotRpcOptions = {},
): Promise<{ builds: DepotBuild[]; nextPageToken: string | null }> {
  const projectId = effectiveProjectId(args.projectId);
  const body: Record<string, unknown> = { projectId };
  if (args.pageSize !== undefined) body.pageSize = args.pageSize;
  if (args.pageToken !== undefined) body.pageToken = args.pageToken;
  const res = await depotRpc<{ builds?: DepotBuild[]; nextPageToken?: string }>(
    'depot.build.v1.BuildService/ListBuilds',
    body,
    opts,
  );
  let builds = res.builds ?? [];
  // Status filter is applied client-side: the Connect filter field name is not
  // stable across API versions, so we filter the returned page to be safe.
  if (args.status) {
    const want = args.status.toLowerCase();
    builds = builds.filter((b) => String(b.status ?? '').toLowerCase().includes(want));
  }
  return { builds, nextPageToken: res.nextPageToken ?? null };
}

/**
 * Get a single build (status + a logs summary if the API returns one).
 * RPC: depot.build.v1.BuildService/GetBuild (verified-stable).
 */
export async function getBuild(buildId: string, projectId?: string, opts: DepotRpcOptions = {}): Promise<{ build: DepotBuild | null }> {
  const body: Record<string, unknown> = { buildId };
  const pid = projectId || env.DEPOT_PROJECT_ID;
  if (pid) body.projectId = pid;
  const res = await depotRpc<{ build?: DepotBuild }>('depot.build.v1.BuildService/GetBuild', body, opts);
  return { build: res.build ?? null };
}

/**
 * Org / project usage + grant burn.
 * TODO(verify): the exact usage RPC is not fully documented publicly. The most
 * likely Connect method is depot.core.v1.ProjectService/GetProjectUsage (scoped)
 * or an org-level depot.core.v1.OrganizationService/GetUsage. We attempt the
 * project-scoped one first and fall back to the org one, surfacing a clear
 * "re-verify the RPC name" error (depot_rpc_unimplemented) if both are absent.
 * Re-confirm against https://depot.dev/docs/api and pin the real name here.
 */
export async function getUsage(
  args: { projectId?: string },
  opts: DepotRpcOptions = {},
): Promise<{ usage: unknown; source_rpc: string }> {
  const projectId = args.projectId || env.DEPOT_PROJECT_ID;
  if (projectId) {
    try {
      const res = await depotRpc<unknown>('depot.core.v1.ProjectService/GetProjectUsage', { projectId }, opts);
      return { usage: res, source_rpc: 'depot.core.v1.ProjectService/GetProjectUsage' };
    } catch (err) {
      if (!(err instanceof DepotApiError) || err.code !== 'depot_rpc_unimplemented') throw err;
      // fall through to org-level
    }
  }
  const res = await depotRpc<unknown>('depot.core.v1.OrganizationService/GetUsage', {}, opts);
  return { usage: res, source_rpc: 'depot.core.v1.OrganizationService/GetUsage' };
}

/**
 * Build cache list / usage for a project.
 * TODO(verify): cache RPCs live under a CacheService; the exact method name for
 * "describe / usage" is not stably documented. We attempt
 * depot.core.v1.ProjectService/GetCacheUsage. If unimplemented, the tool returns
 * a clear error pointing here. Re-confirm against https://depot.dev/docs/api.
 */
export async function getCacheUsage(
  args: { projectId?: string },
  opts: DepotRpcOptions = {},
): Promise<{ cache: unknown; source_rpc: string }> {
  const projectId = effectiveProjectId(args.projectId);
  const res = await depotRpc<unknown>('depot.core.v1.ProjectService/GetCacheUsage', { projectId }, opts);
  return { cache: res, source_rpc: 'depot.core.v1.ProjectService/GetCacheUsage' };
}

/**
 * GUARDED WRITE: reset / purge a project's build cache. Destructive (drops the
 * cache, slows the next build). Gated behind ENABLE_WRITE_TOOLS via the tool.
 * TODO(verify): the reset RPC name. Most likely
 * depot.core.v1.ProjectService/ResetProjectCache. Re-confirm before relying on it.
 */
export async function resetCache(
  args: { projectId?: string },
  opts: DepotRpcOptions = {},
): Promise<{ result: unknown; source_rpc: string }> {
  const projectId = effectiveProjectId(args.projectId);
  const res = await depotRpc<unknown>('depot.core.v1.ProjectService/ResetProjectCache', { projectId }, opts);
  return { result: res, source_rpc: 'depot.core.v1.ProjectService/ResetProjectCache' };
}
