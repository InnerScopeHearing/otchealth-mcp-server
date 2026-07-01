/**
 * Azure AI Content Safety client.
 *
 * Required env vars:
 *   CONTENT_SAFETY_ENDPOINT  — e.g. https://cs-otchealth.cognitiveservices.azure.com
 *   CONTENT_SAFETY_KEY       — sent as header Ocp-Apim-Subscription-Key
 *
 * When either var is absent the functions return inert/skipped results rather
 * than throwing, matching the graceful-degradation pattern used by other
 * connectors in this repo.
 */

import { fetchWithBudget } from '../util/fetch-budget.js';

// ---------------------------------------------------------------------------
// Config helpers — read directly from process.env (loadEnv schema doesn't
// know these vars yet; the CTO will add them during integration).
// ---------------------------------------------------------------------------

function endpoint(): string | undefined {
  return process.env.CONTENT_SAFETY_ENDPOINT?.replace(/\/+$/, '');
}

function apiKey(): string | undefined {
  return process.env.CONTENT_SAFETY_KEY;
}

function isConfigured(): boolean {
  return Boolean(endpoint() && apiKey());
}

// ---------------------------------------------------------------------------
// Shared HTTP helper — mirrors sentry/api-client.ts: undici `request`,
// JSON parse with raw fallback, throws on 4xx/5xx.
// ---------------------------------------------------------------------------

export class ContentSafetyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly nextStep: string;
  constructor(a: { code: string; status: number; message: string; nextStep: string }) {
    super(a.message);
    this.name = 'ContentSafetyError';
    this.code = a.code;
    this.status = a.status;
    this.nextStep = a.nextStep;
  }
}

async function csPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const base = endpoint()!;
  const key = apiKey()!;
  const url = `${base}${path}`;

  // Both callers (shieldPrompt, detectGroundedness) are stateless classification
  // queries with no side effect: safe to retry once on a network blip / 429 / 5xx.
  const res = await fetchWithBudget(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': key,
    },
    body: JSON.stringify(body),
  }, { retries: 1 });

  const statusCode = res.status;
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (statusCode >= 400) {
    const msg = (data as any)?.error?.message ?? `HTTP ${statusCode}`;
    throw new ContentSafetyError({
      code: `content_safety_${statusCode}`,
      status: statusCode,
      message: msg,
      nextStep: 'Verify CONTENT_SAFETY_ENDPOINT and CONTENT_SAFETY_KEY, then check Azure quota.',
    });
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// (a) Prompt Shields — detect prompt-injection / jailbreak attacks
// POST {endpoint}/contentsafety/text:shieldPrompt?api-version=2024-09-01
// ---------------------------------------------------------------------------

export interface ShieldPromptResult {
  attackDetected: boolean;
  userPromptAttack: boolean;
  documentsAttack: boolean;
  raw: unknown;
}

export async function shieldPrompt(
  userPrompt: string,
  documents?: string[],
): Promise<ShieldPromptResult> {
  if (!isConfigured()) {
    return {
      attackDetected: false,
      userPromptAttack: false,
      documentsAttack: false,
      raw: { skipped: 'CONTENT_SAFETY not configured' },
    };
  }

  const raw = await csPost<any>(
    '/contentsafety/text:shieldPrompt?api-version=2024-09-01',
    {
      userPrompt,
      ...(documents && documents.length > 0 ? { documents } : {}),
    },
  );

  // API response shape:
  // { userPromptAnalysis: { attackDetected: boolean },
  //   documentsAnalysis: [{ attackDetected: boolean }, ...] }
  const userPromptAttack: boolean = raw?.userPromptAnalysis?.attackDetected === true;
  const documentsAttack: boolean = Array.isArray(raw?.documentsAnalysis)
    ? (raw.documentsAnalysis as any[]).some((d) => d?.attackDetected === true)
    : false;

  return {
    attackDetected: userPromptAttack || documentsAttack,
    userPromptAttack,
    documentsAttack,
    raw,
  };
}

// ---------------------------------------------------------------------------
// (b) Groundedness Detection — detect hallucinations / ungrounded claims
// POST {endpoint}/contentsafety/text:detectGroundedness?api-version=2024-09-15-preview
// ---------------------------------------------------------------------------

export interface GroundednessResult {
  ungroundedDetected: boolean;
  ungroundedPercentage: number;
  raw: unknown;
}

export async function detectGroundedness(
  query: string,
  text: string,
  groundingSources: string[],
): Promise<GroundednessResult> {
  if (!isConfigured()) {
    return {
      ungroundedDetected: false,
      ungroundedPercentage: 0,
      raw: { skipped: 'CONTENT_SAFETY not configured' },
    };
  }

  const raw = await csPost<any>(
    '/contentsafety/text:detectGroundedness?api-version=2024-09-15-preview',
    {
      domain: 'Generic',
      task: 'QnA',
      qna: { query },
      text,
      groundingSources,
    },
  );

  // API response shape:
  // { ungroundedDetected: boolean, ungroundedPercentage: number, ... }
  const ungroundedDetected: boolean = raw?.ungroundedDetected === true;
  const ungroundedPercentage: number =
    typeof raw?.ungroundedPercentage === 'number' ? raw.ungroundedPercentage : 0;

  return { ungroundedDetected, ungroundedPercentage, raw };
}
