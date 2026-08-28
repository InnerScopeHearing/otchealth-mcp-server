/**
 * Azure AI Content Safety client — RETIRED (2026-08-28, FND-20260821-e303).
 *
 * Historical config (documented only — see the retirement notice below):
 *   CONTENT_SAFETY_ENDPOINT  — e.g. https://cs-otchealth.cognitiveservices.azure.com
 *   CONTENT_SAFETY_KEY       — sent as header Ocp-Apim-Subscription-Key
 *
 * RETIREMENT: Azure subscription 55c84f6b, which hosted that resource, was permanently deleted
 * 2026-08-13. The resource's key auth had ALREADY been silently broken (HTTP 401) since
 * ~2026-07-02, so this provider had not actually scanned anything for weeks before the
 * subscription death either. SHIELD_MODE=report (the default) plus every caller's fail-open
 * error handling (safety/auto-guard.ts) meant that 401 degraded to the EXACT same "ran:false"
 * outcome as "not configured" — so the outage was invisible. Worse: shield_check /
 * groundedness_check kept returning attackDetected:false / ungroundedDetected:false with no
 * indication a scan had never actually happened — a fake PASS, not an honest "did not run".
 *
 * This module now hard-disables the Azure call path via CONTENT_SAFETY_RETIRED below.
 * isConfigured() returns false UNCONDITIONALLY, regardless of whether legacy
 * CONTENT_SAFETY_ENDPOINT / CONTENT_SAFETY_KEY values are still present on a task definition, so
 * shieldPrompt() / detectGroundedness() never again attempt a network call to a host that cannot
 * answer. Every result now also carries an honest `provider` label
 * (CONTENT_SAFETY_PROVIDER_NONE = "none (azure retired)") and a `configured` boolean, distinct
 * from a bare "not configured", so a caller — or a human reading logs — can tell "this was
 * deliberately retired" apart from "nobody has wired credentials yet", and so a tool built on top
 * of this (shield_check / groundedness_check) can tell "did not run" apart from "ran clean".
 *
 * The live-call implementation below is left in place, UNREACHABLE, as documentation of the old
 * API contract — not as a "just flip the flag" reactivation path. A replacement provider (e.g.
 * AWS Bedrock Guardrails) is a SEPARATE, not-yet-made decision (see FND-20260821-e303) and needs
 * its own implementation, its own auth (SigV4, not an API key), and its own review; it does not
 * get wired by restoring CONTENT_SAFETY_ENDPOINT/KEY or flipping CONTENT_SAFETY_RETIRED alone.
 *
 * shield_check / groundedness_check (src/tools/safety/) and the SHIELD_MODE / GROUNDEDNESS_MODE /
 * RETRIEVAL_SHIELD_MODE auto-guard plumbing (src/safety/auto-guard.ts) stay fully wired: every
 * mode / self-tool / short-circuit rule still applies exactly as before. They now simply always
 * observe the honest "ran:false, not configured" state instead of intermittently, silently
 * degrading into it the moment a 401 was thrown.
 */

import { fetchWithBudget } from '../util/fetch-budget.js';

/**
 * Hard kill-switch for the Azure Content Safety call path. TRUE, permanently, until a real
 * replacement provider is implemented and reviewed (see the module doc comment above). Do not
 * gate this on env-var presence — the entire point is that a stale CONTENT_SAFETY_* value left
 * over on an old task definition must never cause a network call to a dead host again.
 */
export const CONTENT_SAFETY_RETIRED: boolean = true;

/** The honest provider label every result carries while retired. */
export const CONTENT_SAFETY_PROVIDER_NONE = 'none (azure retired)';

const RETIRED_REASON =
  'Content Safety has no active provider: Azure subscription 55c84f6b ' +
  '(cs-otchealth.cognitiveservices.azure.com) was permanently deleted 2026-08-13, and this ' +
  "resource's key auth had already been broken since ~2026-07-02 (FND-20260821-e303). No " +
  'replacement provider is wired — this result is not a scan verdict.';

// ---------------------------------------------------------------------------
// Config helpers — read directly from process.env (loadEnv schema doesn't
// know these vars). Retained only as a record of the old provider's config shape;
// CONTENT_SAFETY_RETIRED above means neither is actually consulted to decide whether to call
// out today.
// ---------------------------------------------------------------------------

function endpoint(): string | undefined {
  return process.env.CONTENT_SAFETY_ENDPOINT?.replace(/\/+$/, '');
}

function apiKey(): string | undefined {
  return process.env.CONTENT_SAFETY_KEY;
}

function isConfigured(): boolean {
  return !CONTENT_SAFETY_RETIRED && Boolean(endpoint() && apiKey());
}

function retiredSkip(): { skipped: string; provider: string } {
  return { skipped: RETIRED_REASON, provider: CONTENT_SAFETY_PROVIDER_NONE };
}

// ---------------------------------------------------------------------------
// Shared HTTP helper — mirrors sentry/api-client.ts: undici `request`,
// JSON parse with raw fallback, throws on 4xx/5xx. UNREACHABLE while CONTENT_SAFETY_RETIRED is
// true; kept as the documented shape of the old (dead) API contract — see module doc comment.
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
  /** True only when a live provider actually ran a scan. FALSE while retired (always, today) —
   *  attackDetected is not a scan verdict when this is false; check this first. */
  configured: boolean;
  attackDetected: boolean;
  userPromptAttack: boolean;
  documentsAttack: boolean;
  /** Honest label: CONTENT_SAFETY_PROVIDER_NONE while retired; 'azure' if a live call ever runs. */
  provider: string;
  raw: unknown;
}

export async function shieldPrompt(
  userPrompt: string,
  documents?: string[],
): Promise<ShieldPromptResult> {
  if (!isConfigured()) {
    return {
      configured: false,
      attackDetected: false,
      userPromptAttack: false,
      documentsAttack: false,
      provider: CONTENT_SAFETY_PROVIDER_NONE,
      raw: retiredSkip(),
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
    configured: true,
    attackDetected: userPromptAttack || documentsAttack,
    userPromptAttack,
    documentsAttack,
    provider: 'azure',
    raw,
  };
}

// ---------------------------------------------------------------------------
// (b) Groundedness Detection — detect hallucinations / ungrounded claims
// POST {endpoint}/contentsafety/text:detectGroundedness?api-version=2024-09-15-preview
// ---------------------------------------------------------------------------

export interface GroundednessResult {
  /** True only when a live provider actually ran a check. FALSE while retired (always, today) —
   *  ungroundedDetected is not a check verdict when this is false; check this first. */
  configured: boolean;
  ungroundedDetected: boolean;
  ungroundedPercentage: number;
  /** Honest label: CONTENT_SAFETY_PROVIDER_NONE while retired; 'azure' if a live call ever runs. */
  provider: string;
  raw: unknown;
}

export async function detectGroundedness(
  query: string,
  text: string,
  groundingSources: string[],
): Promise<GroundednessResult> {
  if (!isConfigured()) {
    return {
      configured: false,
      ungroundedDetected: false,
      ungroundedPercentage: 0,
      provider: CONTENT_SAFETY_PROVIDER_NONE,
      raw: retiredSkip(),
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

  return { configured: true, ungroundedDetected, ungroundedPercentage, provider: 'azure', raw };
}
