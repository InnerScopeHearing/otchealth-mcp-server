/**
 * n8n WRITE client — NEW file. Never edit api-client.ts or webhook-client.ts.
 * Auth + request helper mirrors api-client.ts exactly (same base URL, same
 * x-n8n-api-key header, same N8nApiError shape).
 *
 * Covered operations
 *  Lifecycle : activateWorkflow, deactivateWorkflow
 *  CRUD      : createWorkflow, updateWorkflow
 *  Trigger   : runWorkflow (webhook-based, mirrors webhook-client.ts pattern)
 */

import { request } from 'undici';
import { createHmac } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

// ── Error ────────────────────────────────────────────────────────────────────

export class N8nWriteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  readonly upstream?: unknown;

  constructor(args: { code: string; status: number; message: string; nextStep: string; upstream?: unknown }) {
    super(args.message);
    this.name = 'N8nWriteError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
    if (args.upstream !== undefined) this.upstream = args.upstream;
  }
}

// ── Auth helpers (mirrors api-client.ts) ─────────────────────────────────────

function requireKey(): string {
  if (!env.N8N_API_KEY) {
    throw new N8nWriteError({
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

// ── Error mapper (mirrors api-client.ts mapError) ────────────────────────────

function mapError(status: number, path: string, body: string): N8nWriteError {
  let upstream: unknown = body;
  try { upstream = JSON.parse(body); } catch { /* keep raw */ }
  if (status === 401 || status === 403) {
    return new N8nWriteError({
      code: 'n8n_auth_failed',
      status,
      message: `n8n API rejected auth on ${path}.`,
      nextStep: 'Confirm N8N_API_KEY in Railway matches the Notion vault value. Note: n8n uses X-N8N-API-KEY header, not bearer.',
      upstream,
    });
  }
  if (status === 404) {
    return new N8nWriteError({
      code: 'n8n_not_found',
      status,
      message: `n8n returned 404 for ${path}.`,
      nextStep: 'Verify the workflow ID. Use n8n_list_workflows to find IDs.',
      upstream,
    });
  }
  if (status === 400) {
    return new N8nWriteError({
      code: 'n8n_bad_request',
      status,
      message: `n8n returned 400 for ${path}.`,
      nextStep: 'Check the workflow body for missing required fields (name, nodes, connections, settings).',
      upstream,
    });
  }
  return new N8nWriteError({
    code: status >= 500 ? 'n8n_upstream_error' : 'n8n_request_error',
    status,
    message: `n8n returned ${status} for ${path}.`,
    nextStep: 'Check n8n instance health or your Hetzner/Railway n8n deployment.',
    upstream,
  });
}

// ── Core HTTP helper ─────────────────────────────────────────────────────────

async function n8nWrite<T = unknown>(
  method: string,
  path: string,
  opts?: { body?: unknown; correlationId?: string; timeoutMs?: number },
): Promise<T> {
  const key = requireKey();
  const url = `${baseUrl()}/api/v1${path}`;
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
        { type: 'n8n_write_ok', path, method, status: res.statusCode, latency_ms: latency, correlation_id: opts?.correlationId },
        'n8n write ok',
      );
      return body ? (JSON.parse(body) as T) : ({} as T);
    }
    throw mapError(res.statusCode, path, body);
  } catch (err) {
    if (err instanceof N8nWriteError) throw err;
    throw new N8nWriteError({
      code: 'n8n_network_error',
      status: 0,
      message: `Network error calling n8n API at ${path}: ${(err as Error).message}`,
      nextStep: `Verify ${env.N8N_BASE_URL} is reachable. Check Railway logs.`,
      upstream: err,
    });
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/workflows/{id}/activate
 * Activates a workflow so its trigger nodes begin listening.
 */
export async function activateWorkflow(
  workflowId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nWrite('POST', `/workflows/${workflowId}/activate`, { correlationId: opts?.correlationId });
}

/**
 * POST /api/v1/workflows/{id}/deactivate
 * Deactivates a workflow, stopping its trigger nodes from firing.
 */
export async function deactivateWorkflow(
  workflowId: string,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nWrite('POST', `/workflows/${workflowId}/deactivate`, { correlationId: opts?.correlationId });
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export interface N8nWorkflowBody {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: Record<string, unknown> | null;
  tags?: Array<{ id?: string; name?: string }>;
}

/**
 * POST /api/v1/workflows
 * Creates a new workflow. The workflow is created in inactive state.
 */
export async function createWorkflow(
  body: N8nWorkflowBody,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nWrite('POST', '/workflows', { body, correlationId: opts?.correlationId });
}

/**
 * PUT /api/v1/workflows/{id}
 * Full replacement of a workflow definition.
 */
export async function updateWorkflow(
  workflowId: string,
  body: N8nWorkflowBody,
  opts?: { correlationId?: string },
): Promise<any> {
  return n8nWrite('PUT', `/workflows/${workflowId}`, { body, correlationId: opts?.correlationId });
}

// ── Webhook trigger ───────────────────────────────────────────────────────────

export interface RunWorkflowArgs {
  /** Webhook path registered on the workflow, e.g. "/webhook/my-workflow". */
  webhookPath: string;
  payload: unknown;
  toolName: string;
  callerHash: string;
  correlationId: string;
  timeoutMs?: number;
}

export interface RunWorkflowResult {
  success: boolean;
  result?: unknown;
  error?: string;
  audit_payload?: { before?: unknown; after?: unknown };
}

/**
 * Trigger a workflow via its n8n webhook, using HMAC-SHA256 signing.
 * Mirrors webhook-client.ts callN8nWebhook exactly so callers get the
 * same signed-POST semantics whether they go through write-client or
 * webhook-client.
 */
export async function runWorkflow(args: RunWorkflowArgs): Promise<RunWorkflowResult> {
  const webhookSecret = env.N8N_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new N8nWriteError({
      code: 'n8n_webhook_not_configured',
      status: 0,
      message: 'N8N_WEBHOOK_SECRET is not set.',
      nextStep: 'Add N8N_WEBHOOK_SECRET to the MCP server environment.',
    });
  }

  const url = `${baseUrl()}${args.webhookPath}`;
  const bodyString = JSON.stringify(args.payload);
  const signature = createHmac('sha256', webhookSecret).update(bodyString, 'utf8').digest('hex');
  const timeout = args.timeoutMs ?? 30_000;
  const started = Date.now();

  try {
    const res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-correlation-id': args.correlationId,
        'x-tool-name': args.toolName,
        'x-caller-hash': args.callerHash,
        'x-signature-sha256': signature,
      },
      body: bodyString,
      bodyTimeout: timeout,
      headersTimeout: timeout,
    });
    const text = await res.body.text();
    const latency = Date.now() - started;
    logger.info(
      { type: 'n8n_run_webhook_response', tool: args.toolName, correlation_id: args.correlationId, status: res.statusCode, latency_ms: latency },
      'n8n run webhook response',
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new N8nWriteError({
        code: 'n8n_upstream_error',
        status: res.statusCode,
        message: `n8n webhook returned ${res.statusCode} for ${args.webhookPath}.`,
        nextStep: `Check n8n execution log at ${env.N8N_BASE_URL}/executions for tool ${args.toolName}.`,
      });
    }
    if (!text) {
      throw new N8nWriteError({
        code: 'n8n_empty_response',
        status: res.statusCode,
        message: `n8n workflow returned ${res.statusCode} with empty body for ${args.webhookPath}. Workflow likely halted on an unhandled node error.`,
        nextStep: `Inspect the n8n execution log at ${env.N8N_BASE_URL}/executions for correlation_id ${args.correlationId}.`,
      });
    }
    try {
      const parsed = JSON.parse(text) as RunWorkflowResult;
      if (parsed.success === false) {
        throw new N8nWriteError({
          code: 'n8n_workflow_reported_failure',
          status: res.statusCode,
          message: `n8n workflow reported failure: ${parsed.error ?? 'unspecified'}`,
          nextStep: `Check the audit_payload returned by ${args.toolName} and inspect ${env.N8N_BASE_URL}/executions for correlation_id ${args.correlationId}.`,
        });
      }
      return parsed;
    } catch (parseErr) {
      if (parseErr instanceof N8nWriteError) throw parseErr;
      throw new N8nWriteError({
        code: 'n8n_unparseable_response',
        status: res.statusCode,
        message: `n8n returned non-JSON 2xx body for ${args.webhookPath}: ${text.slice(0, 200)}`,
        nextStep: `Verify the workflow's respondToWebhook node returns JSON (respondWith: 'json').`,
      });
    }
  } catch (err) {
    if (err instanceof N8nWriteError) throw err;
    throw new N8nWriteError({
      code: 'n8n_network_error',
      status: 0,
      message: `Network error calling n8n webhook ${args.webhookPath}: ${(err as Error).message}`,
      nextStep: `Verify ${env.N8N_BASE_URL} is reachable and the webhook is active.`,
    });
  }
}
