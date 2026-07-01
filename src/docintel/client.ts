/**
 * Azure Document Intelligence (Form Recognizer) API client.
 *
 * Required env vars:
 *   DOCINTEL_ENDPOINT  – e.g. https://di-otchealth.cognitiveservices.azure.com
 *   DOCINTEL_KEY       – Azure subscription key (Ocp-Apim-Subscription-Key)
 *
 * PHI / RING SAFETY WARNING:
 *   This gateway is NOT covered by a Business Associate Agreement (BAA).
 *   NEVER route PHI, MedReview documents, or any clinical records through
 *   these tools. Permitted content: CFO finance documents (invoices, receipts)
 *   and CLO commercial contracts only. PHI goes to the BAA-covered engine.
 */

import { fetchWithBudget } from '../util/fetch-budget.js';

const API_VERSION = '2024-11-30';
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 25_000;

// Read secrets directly from process.env (no loadEnv() — new connector, no
// shared config key yet; the CTO adds it to config/env.ts).
function endpoint(): string {
  return (process.env['DOCINTEL_ENDPOINT'] ?? '').replace(/\/$/, '');
}
function apiKey(): string {
  return process.env['DOCINTEL_KEY'] ?? '';
}
function isConfigured(): boolean {
  return endpoint() !== '' && apiKey() !== '';
}

export interface AnalyzeSource {
  urlSource?: string;
  base64Source?: string;
}

export interface AnalyzeResultOk {
  status: 'succeeded';
  analyzeResult: Record<string, unknown>;
}

export interface AnalyzeResultFailed {
  status: 'failed' | 'timedOut' | 'notConfigured';
  error?: string;
}

export type AnalyzeOutcome = AnalyzeResultOk | AnalyzeResultFailed;

export class DocIntelApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  constructor(args: { code: string; status: number; message: string; nextStep: string }) {
    super(args.message);
    this.name = 'DocIntelApiError';
    this.code = args.code;
    this.status = args.status;
    this.nextStep = args.nextStep;
  }
}

/**
 * Analyze a document against a Document Intelligence model.
 *
 * Submits the job, polls Operation-Location until succeeded/failed/timeout,
 * and returns the full analyzeResult blob.
 *
 * On missing credentials, returns a flagged inert result (no throw) so the
 * gateway continues to boot with partial config.
 */
export async function analyzeDocument(
  modelId: string,
  source: AnalyzeSource,
): Promise<AnalyzeOutcome> {
  if (!isConfigured()) {
    return {
      status: 'notConfigured',
      error: 'DOCINTEL_ENDPOINT or DOCINTEL_KEY not set. Add them to the MCP server environment.',
    };
  }

  const ep = endpoint();
  const key = apiKey();
  const analyzeUrl =
    `${ep}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze` +
    `?api-version=${API_VERSION}`;

  const body: Record<string, string> = {};
  if (source.urlSource) body['urlSource'] = source.urlSource;
  if (source.base64Source) body['base64Source'] = source.base64Source;

  // --- Submit analysis job ---
  // Non-idempotent: starts a billed Document Intelligence analysis job. retries:0 so a
  // timeout never submits a duplicate (and doubly-billed) analysis.
  const submitRes = await fetchWithBudget(analyzeUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, { retries: 0 });
  const submitStatus = submitRes.status;
  await submitRes.arrayBuffer(); // drain the body to release the connection

  if (submitStatus !== 202) {
    // Non-202 means immediate error — drain and surface it
    throw new DocIntelApiError({
      code: `docintel_${submitStatus}`,
      status: submitStatus,
      message: `Document Intelligence submit returned HTTP ${submitStatus} (expected 202).`,
      nextStep: 'Verify DOCINTEL_ENDPOINT and DOCINTEL_KEY. Check Azure portal for quota limits.',
    });
  }

  const operationLocation = submitRes.headers.get('operation-location');
  if (!operationLocation) {
    throw new DocIntelApiError({
      code: 'docintel_missing_operation_location',
      status: 202,
      message: 'Azure DI returned 202 but no Operation-Location header.',
      nextStep: 'This is an Azure API contract violation — raise with Azure Support.',
    });
  }

  // --- Poll until terminal state or timeout ---
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    // Read-only poll: safe to retry once on a network blip / 429 / 5xx.
    const pollRes = await fetchWithBudget(operationLocation, {
      method: 'GET',
      headers: { 'Ocp-Apim-Subscription-Key': key },
    }, { retries: 1 });
    const pollStatus = pollRes.status;
    const pollText = await pollRes.text();
    let pollData: any;
    try { pollData = JSON.parse(pollText); } catch { pollData = { raw: pollText }; }

    if (pollStatus >= 400) {
      throw new DocIntelApiError({
        code: `docintel_poll_${pollStatus}`,
        status: pollStatus,
        message: pollData?.error?.message ?? `Poll request returned HTTP ${pollStatus}.`,
        nextStep: 'Operation-Location URL may have expired or key is invalid.',
      });
    }

    const opStatus: string = pollData?.status ?? '';

    if (opStatus === 'succeeded') {
      return { status: 'succeeded', analyzeResult: pollData.analyzeResult ?? pollData };
    }

    if (opStatus === 'failed') {
      const errMsg = pollData?.error?.message ?? 'Azure DI reported operation failed.';
      return { status: 'failed', error: errMsg };
    }

    // opStatus is 'running' or 'notStarted' — keep polling
  }

  return {
    status: 'timedOut',
    error: `Document Intelligence analysis did not complete within ${POLL_TIMEOUT_MS / 1000}s.`,
  };
}

// ---- helpers ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pluck a field value from the DI fields map. Returns the content string or
 * undefined if absent. DI field objects carry { content, valueString, valueDate,
 * valueNumber, ... } — we prefer the typed value, falling back to content.
 */
export function fieldValue(fields: Record<string, any> | undefined, key: string): string | undefined {
  const f = fields?.[key];
  if (!f) return undefined;
  // Prefer typed scalar values over raw content
  const typed =
    f.valueString ??
    f.valueDate ??
    f.valueNumber ??
    f.valueCurrency?.amount ??
    f.content;
  return typed !== undefined && typed !== null ? String(typed) : undefined;
}

/**
 * Extract currency code from a currency field (if present).
 */
export function fieldCurrency(fields: Record<string, any> | undefined, key: string): string | undefined {
  return fields?.[key]?.valueCurrency?.currencyCode ?? undefined;
}

/**
 * Return an array from a DI array field, or [] if absent.
 */
export function fieldArray(fields: Record<string, any> | undefined, key: string): any[] {
  return fields?.[key]?.valueArray ?? [];
}
