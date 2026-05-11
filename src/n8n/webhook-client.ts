/**
 * MCP server → n8n webhook bridge. Per ADR-001 Section 5:
 *  - HTTPS POST to an n8n webhook URL
 *  - HMAC-SHA256 over the request body using N8N_WEBHOOK_SECRET
 *  - Required headers: X-Correlation-Id, X-Tool-Name, X-Caller-Hash
 *  - Default timeout 30s, configurable per tool
 *  - Audit log entry is written BEFORE this call; this function only does the hop.
 */

import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

export interface N8nWebhookCallArgs {
  webhookPath: string; // e.g. "/webhook/cio-update-newsletter-variant"
  payload: unknown;
  toolName: string;
  callerHash: string;
  correlationId: string;
  timeoutMs?: number;
}

export interface N8nWebhookResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  audit_payload?: { before?: unknown; after?: unknown };
}

export class N8nWebhookError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;

  constructor(args: { code: string; status: number; message: string; nextStep: string }) {
    super(args.message);
    this.name = 'N8nWebhookError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
  }
}

function signBody(body: string): string {
  return createHmac('sha256', env.N8N_WEBHOOK_SECRET).update(body, 'utf8').digest('hex');
}

export async function callN8nWebhook(args: N8nWebhookCallArgs): Promise<N8nWebhookResponse> {
  const url = `${env.N8N_BASE_URL.replace(/\/$/, '')}${args.webhookPath}`;
  const bodyString = JSON.stringify(args.payload);
  const signature = signBody(bodyString);
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
      {
        type: 'n8n_webhook_response',
        tool: args.toolName,
        correlation_id: args.correlationId,
        status: res.statusCode,
        latency_ms: latency,
      },
      'n8n webhook response',
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new N8nWebhookError({
        code: 'n8n_upstream_error',
        status: res.statusCode,
        message: `n8n webhook returned ${res.statusCode} for ${args.webhookPath}.`,
        nextStep: `Check n8n execution log at ${env.N8N_BASE_URL}/executions for tool ${args.toolName}.`,
      });
    }
    if (!text) return { success: true };
    try {
      const parsed = JSON.parse(text) as N8nWebhookResponse;
      return parsed;
    } catch {
      return { success: true, result: text };
    }
  } catch (err) {
    if (err instanceof N8nWebhookError) throw err;
    throw new N8nWebhookError({
      code: 'n8n_network_error',
      status: 0,
      message: `Network error calling n8n webhook ${args.webhookPath}: ${(err as Error).message}`,
      nextStep: `Verify ${env.N8N_BASE_URL} is reachable and the webhook is active.`,
    });
  }
}
