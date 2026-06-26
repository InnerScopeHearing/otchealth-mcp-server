/**
 * n8n FULL client — exhaustive coverage of n8n Public REST API v1.
 * Self-contained: auth + request helper copied from api-client.ts / write-client.ts.
 * Do NOT edit api-client.ts, write-client.ts, or webhook-client.ts.
 *
 * Covered resources:
 *  Workflows  : getWorkflow, deleteWorkflow, listWorkflowsFiltered, transferWorkflow
 *  Executions : listExecutions, deleteExecution
 *  Credentials: listCredentials (names/types ONLY — never secrets), getCredentialSchema,
 *               createCredential, deleteCredential
 *  Tags       : listTags, getTag, createTag, updateTag, deleteTag,
 *               getWorkflowTags, updateWorkflowTags
 *  Variables  : listVariables, createVariable, updateVariable, deleteVariable
 *  Users      : listUsers, getUser
 *  Projects   : listProjects, getProject, createProject, updateProject, deleteProject
 *  Source ctrl: pullSourceControl
 *  Audit      : generateAudit
 */

import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

// ── Error ─────────────────────────────────────────────────────────────────────

export class N8nFullError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'N8nFullError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

// ── Auth / helpers ────────────────────────────────────────────────────────────

function requireKey(): string {
  if (!env.N8N_API_KEY) {
    throw new N8nFullError({
      code: 'n8n_not_configured',
      status: 0,
      message: 'n8n public API is not configured.',
      nextStep: "Set N8N_API_KEY in Railway env vars. Value is in Matt's Notion Token Vault under n8n section.",
    });
  }
  return env.N8N_API_KEY;
}

function baseUrl(): string {
  return env.N8N_BASE_URL.replace(/\/$/, '');
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

function mapError(status: number, path: string, body: string): N8nFullError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep raw */ }
  if (status === 401 || status === 403) {
    return new N8nFullError({
      code: 'n8n_auth_failed', status,
      message: `n8n API rejected auth on ${path}.`,
      nextStep: 'Confirm N8N_API_KEY in Railway matches the Notion vault value. n8n uses X-N8N-API-KEY header.',
      upstream,
    });
  }
  if (status === 404) {
    return new N8nFullError({
      code: 'n8n_not_found', status,
      message: `n8n returned 404 for ${path}.`,
      nextStep: 'Verify the resource ID. Use the corresponding list tool to find valid IDs.',
      upstream,
    });
  }
  if (status === 400) {
    return new N8nFullError({
      code: 'n8n_bad_request', status,
      message: `n8n returned 400 for ${path}.`,
      nextStep: 'Check request body for missing required fields. Review n8n API docs.',
      upstream,
    });
  }
  if (status === 409) {
    return new N8nFullError({
      code: 'n8n_conflict', status,
      message: `n8n returned 409 Conflict for ${path}.`,
      nextStep: 'A resource with this name/ID may already exist. Use list tools to check.',
      upstream,
    });
  }
  return new N8nFullError({
    code: status >= 500 ? 'n8n_upstream_error' : 'n8n_request_error',
    status,
    message: `n8n returned ${status} for ${path}.`,
    nextStep: 'Check n8n instance health or your Hetzner/Railway n8n deployment.',
    upstream,
  });
}

async function n8nRequest<T = unknown>(
  method: string,
  path: string,
  opts?: {
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    correlationId?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const key = requireKey();
  const url = `${baseUrl()}/api/v1${path}${buildQuery(opts?.query)}`;
  const started = Date.now();
  try {
    const res = await request(url, {
      method,
      headers: {
        'x-n8n-api-key': key,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      bodyTimeout: opts?.timeoutMs ?? 30_000,
      headersTimeout: opts?.timeoutMs ?? 30_000,
    });
    const body = await res.body.text();
    const latency = Date.now() - started;
    if (res.statusCode >= 200 && res.statusCode < 300) {
      logger.debug(
        { type: 'n8n_full_client_ok', path, method, status: res.statusCode, latency_ms: latency, correlation_id: opts?.correlationId },
        'n8n full client ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, body);
  } catch (err) {
    if (err instanceof N8nFullError) throw err;
    throw new N8nFullError({
      code: 'n8n_network_error',
      status: 0,
      message: `Network error calling n8n API at ${path}: ${(err as Error).message}`,
      nextStep: `Verify ${env.N8N_BASE_URL} is reachable. Check Railway logs.`,
      upstream: err,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKFLOWS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/workflows/{id}
 * Retrieve a single workflow by ID (full definition including nodes/connections).
 */
export async function getWorkflow(
  workflowId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('GET', `/workflows/${workflowId}`, { correlationId: opts?.correlationId });
}

/**
 * DELETE /api/v1/workflows/{id}
 * Permanently delete a workflow. Irreversible.
 */
export async function deleteWorkflow(
  workflowId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('DELETE', `/workflows/${workflowId}`, { correlationId: opts?.correlationId });
}

export interface ListWorkflowsFilteredArgs {
  active?: boolean;
  tags?: string;
  name?: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
  correlationId?: string;
}

/**
 * GET /api/v1/workflows (with extended filters beyond list-workflows tool)
 * Supports projectId filter on top of what the existing list-workflows tool exposes.
 */
export async function listWorkflowsFiltered(args: ListWorkflowsFilteredArgs): Promise<any> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (args.active !== undefined) query.active = args.active;
  if (args.tags) query.tags = args.tags;
  if (args.name) query.name = args.name;
  if (args.projectId) query.projectId = args.projectId;
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  return n8nRequest('GET', '/workflows', { query, correlationId: args.correlationId });
}

/**
 * PUT /api/v1/workflows/{id}/transfer
 * Transfer ownership of a workflow to another project.
 */
export async function transferWorkflow(
  workflowId: string,
  destinationProjectId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('PUT', `/workflows/${workflowId}/transfer`, {
    body: { destinationProjectId },
    correlationId: opts?.correlationId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ListExecutionsArgs {
  workflowId?: string;
  status?: 'error' | 'success' | 'waiting' | 'running';
  limit?: number;
  cursor?: string;
  includeData?: boolean;
  correlationId?: string;
}

/**
 * GET /api/v1/executions
 * List executions with optional workflow/status/pagination filters.
 */
export async function listExecutions(args: ListExecutionsArgs): Promise<any> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (args.workflowId) query.workflowId = args.workflowId;
  if (args.status) query.status = args.status;
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  if (args.includeData !== undefined) query.includeData = args.includeData;
  return n8nRequest('GET', '/executions', { query, correlationId: args.correlationId });
}

/**
 * DELETE /api/v1/executions/{id}
 * Delete an execution record by ID. Irreversible.
 */
export async function deleteExecution(
  executionId: string | number,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('DELETE', `/executions/${executionId}`, { correlationId: opts?.correlationId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREDENTIALS — NAMES / TYPES ONLY.  NEVER return credential data/secrets.
// ═══════════════════════════════════════════════════════════════════════════════

export interface ListCredentialsArgs {
  limit?: number;
  cursor?: string;
  includeScopes?: boolean;
  correlationId?: string;
}

/** Strip any secret-like fields from a credential object before returning. */
function stripCredentialSecrets(cred: any): any {
  if (!cred || typeof cred !== 'object') return cred;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data, oauthTokenData, ...safe } = cred as Record<string, unknown>;
  return safe;
}

/**
 * GET /api/v1/credentials
 * List credentials — returns id, name, type, createdAt, updatedAt ONLY.
 * Credential data values are stripped before return.
 */
export async function listCredentials(args: ListCredentialsArgs): Promise<any> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  if (args.includeScopes !== undefined) query.includeScopes = args.includeScopes;
  const raw = await n8nRequest<any>('GET', '/credentials', { query, correlationId: args.correlationId });
  const items = (raw?.data ?? []).map(stripCredentialSecrets);
  return { data: items, nextCursor: raw?.nextCursor ?? null };
}

/**
 * GET /api/v1/credentials/schema/{credentialTypeName}
 * Retrieve the JSON Schema for a credential type (no secret values).
 */
export async function getCredentialSchema(
  credentialTypeName: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('GET', `/credentials/schema/${encodeURIComponent(credentialTypeName)}`, {
    correlationId: opts?.correlationId,
  });
}

export interface CreateCredentialArgs {
  name: string;
  type: string;
  data: Record<string, unknown>;
  correlationId?: string;
}

/**
 * POST /api/v1/credentials
 * Create a credential. Returns metadata (id, name, type) — never echoes back data.
 */
export async function createCredential(args: CreateCredentialArgs): Promise<any> {
  const raw = await n8nRequest<any>('POST', '/credentials', {
    body: { name: args.name, type: args.type, data: args.data },
    correlationId: args.correlationId,
  });
  return stripCredentialSecrets(raw);
}

/**
 * DELETE /api/v1/credentials/{id}
 * Permanently delete a credential. Irreversible.
 */
export async function deleteCredential(
  credentialId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  const raw = await n8nRequest<any>('DELETE', `/credentials/${credentialId}`, {
    correlationId: opts?.correlationId,
  });
  return stripCredentialSecrets(raw);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ListTagsArgs {
  limit?: number;
  cursor?: string;
  withUsageCount?: boolean;
  correlationId?: string;
}

/** GET /api/v1/tags */
export async function listTags(args: ListTagsArgs): Promise<any> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  if (args.withUsageCount !== undefined) query.withUsageCount = args.withUsageCount;
  return n8nRequest('GET', '/tags', { query, correlationId: args.correlationId });
}

/** GET /api/v1/tags/{id} */
export async function getTag(
  tagId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('GET', `/tags/${tagId}`, { correlationId: opts?.correlationId });
}

/** POST /api/v1/tags */
export async function createTag(
  name: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('POST', '/tags', { body: { name }, correlationId: opts?.correlationId });
}

/** PUT /api/v1/tags/{id} */
export async function updateTag(
  tagId: string,
  name: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('PUT', `/tags/${tagId}`, { body: { name }, correlationId: opts?.correlationId });
}

/** DELETE /api/v1/tags/{id} */
export async function deleteTag(
  tagId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('DELETE', `/tags/${tagId}`, { correlationId: opts?.correlationId });
}

/** GET /api/v1/workflows/{workflowId}/tags */
export async function getWorkflowTags(
  workflowId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('GET', `/workflows/${workflowId}/tags`, { correlationId: opts?.correlationId });
}

/** PUT /api/v1/workflows/{workflowId}/tags — replace full tag set */
export async function updateWorkflowTags(
  workflowId: string,
  tagIds: Array<{ id: string }>,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('PUT', `/workflows/${workflowId}/tags`, {
    body: tagIds,
    correlationId: opts?.correlationId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIABLES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ListVariablesArgs {
  limit?: number;
  cursor?: string;
  correlationId?: string;
}

/** GET /api/v1/variables */
export async function listVariables(args: ListVariablesArgs): Promise<any> {
  const query: Record<string, string | number | undefined> = {};
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  return n8nRequest('GET', '/variables', { query, correlationId: args.correlationId });
}

export interface CreateVariableArgs {
  key: string;
  value: string;
  type?: 'string' | 'number' | 'boolean' | 'object';
  correlationId?: string;
}

/** POST /api/v1/variables */
export async function createVariable(args: CreateVariableArgs): Promise<any> {
  return n8nRequest('POST', '/variables', {
    body: { key: args.key, value: args.value, ...(args.type ? { type: args.type } : {}) },
    correlationId: args.correlationId,
  });
}

export interface UpdateVariableArgs {
  variableId: string;
  key: string;
  value: string;
  type?: 'string' | 'number' | 'boolean' | 'object';
  correlationId?: string;
}

/** PUT /api/v1/variables/{id} */
export async function updateVariable(args: UpdateVariableArgs): Promise<any> {
  return n8nRequest('PUT', `/variables/${args.variableId}`, {
    body: { key: args.key, value: args.value, ...(args.type ? { type: args.type } : {}) },
    correlationId: args.correlationId,
  });
}

/** DELETE /api/v1/variables/{id} */
export async function deleteVariable(
  variableId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('DELETE', `/variables/${variableId}`, { correlationId: opts?.correlationId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// USERS  (admin-only instance)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ListUsersArgs {
  limit?: number;
  cursor?: string;
  includeRole?: boolean;
  correlationId?: string;
}

/** GET /api/v1/users */
export async function listUsers(args: ListUsersArgs): Promise<any> {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  if (args.includeRole !== undefined) query.includeRole = args.includeRole;
  return n8nRequest('GET', '/users', { query, correlationId: args.correlationId });
}

/** GET /api/v1/users/{id} — id can be UUID or email */
export async function getUser(
  userId: string,
  opts?: { includeRole?: boolean; correlationId?: string },
): Promise<any> {
  const query: Record<string, string | boolean | undefined> = {};
  if (opts?.includeRole !== undefined) query.includeRole = opts.includeRole;
  return n8nRequest('GET', `/users/${encodeURIComponent(userId)}`, {
    query,
    correlationId: opts?.correlationId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════════════════════════

export interface ListProjectsArgs {
  limit?: number;
  cursor?: string;
  correlationId?: string;
}

/** GET /api/v1/projects */
export async function listProjects(args: ListProjectsArgs): Promise<any> {
  const query: Record<string, string | number | undefined> = {};
  if (args.limit !== undefined) query.limit = args.limit;
  if (args.cursor) query.cursor = args.cursor;
  return n8nRequest('GET', '/projects', { query, correlationId: args.correlationId });
}

/** GET /api/v1/projects/{id} (project detail — use list to get IDs) */
export async function getProject(
  projectId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('GET', `/projects/${projectId}`, { correlationId: opts?.correlationId });
}

export interface CreateProjectArgs {
  name: string;
  correlationId?: string;
}

/** POST /api/v1/projects */
export async function createProject(args: CreateProjectArgs): Promise<any> {
  return n8nRequest('POST', '/projects', {
    body: { name: args.name },
    correlationId: args.correlationId,
  });
}

export interface UpdateProjectArgs {
  projectId: string;
  name: string;
  correlationId?: string;
}

/** PUT /api/v1/projects/{id} */
export async function updateProject(args: UpdateProjectArgs): Promise<any> {
  return n8nRequest('PUT', `/projects/${args.projectId}`, {
    body: { name: args.name },
    correlationId: args.correlationId,
  });
}

/** DELETE /api/v1/projects/{id} — permanently removes project and all its resources. */
export async function deleteProject(
  projectId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nRequest('DELETE', `/projects/${projectId}`, { correlationId: opts?.correlationId });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

export interface PullSourceControlArgs {
  force?: boolean;
  variables?: Record<string, string>;
  correlationId?: string;
}

/**
 * POST /api/v1/source-control/pull
 * Pull latest state from the configured source-control branch into n8n.
 */
export async function pullSourceControl(args: PullSourceControlArgs): Promise<any> {
  return n8nRequest('POST', '/source-control/pull', {
    body: {
      force: args.force ?? false,
      ...(args.variables ? { variables: args.variables } : {}),
    },
    correlationId: args.correlationId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════════════════════════════

export interface GenerateAuditArgs {
  additionalOptions?: {
    daysAbandonedWorkflow?: number;
    categories?: string[];
  };
  correlationId?: string;
}

/**
 * POST /api/v1/audit
 * Generate a security audit report for the n8n instance.
 */
export async function generateAudit(args: GenerateAuditArgs): Promise<any> {
  return n8nRequest('POST', '/audit', {
    body: args.additionalOptions ? { additionalOptions: args.additionalOptions } : {},
    correlationId: args.correlationId,
  });
}
