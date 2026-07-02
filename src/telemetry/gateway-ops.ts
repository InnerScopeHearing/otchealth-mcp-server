/**
 * Gateway Ops telemetry — fire-and-forget PostHog capture for gateway-internal OPS events
 * (governance would-deny decisions, per-call LLM cost/usage). OBSERVE-ONLY: emitting an
 * event changes zero request behavior, never blocks, and never throws into the hot path.
 *
 * INERT BY DEFAULT: a no-op unless POSTHOG_GATEWAYOPS_KEY is set, so merging + deploying
 * this module changes nothing observable until the key is wired on the app (graduated
 * rollout: ship the code dark, then flip on the key and watch the events land).
 *
 * Events land in the dedicated PostHog "Gateway Ops" project (id 493944), kept separate
 * from product analytics. The MedReview PHI project (468398) is never touched here.
 */
import { loadEnv } from '../config/env.js';

export interface CapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/**
 * Pure, testable, env-free: build the PostHog capture body, or null when telemetry is
 * disabled (no key). No IO, no env read — the key is passed in, so this is deterministic
 * and unit-testable without any environment setup.
 */
export function buildCapturePayload(
  event: string,
  properties: Record<string, unknown>,
  distinctId?: string,
  key?: string,
): CapturePayload | null {
  if (!key) return null;
  return {
    api_key: key,
    event,
    distinct_id: distinctId || 'gateway',
    properties: { source: 'otchealth-mcp-server', ...properties },
    timestamp: new Date().toISOString(),
  };
}

export interface UsageSummary {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  cached_pct: number;
}

/**
 * Pure, env-free: normalize an Azure OpenAI `usage` object into a flat, dashboard-friendly summary,
 * surfacing prompt_tokens_details.cached_tokens (the automatic-prefix-cache hit count) and the cache
 * hit percentage. Tolerant of missing/partial usage. Token-based only, no dollar estimate (the cost
 * dashboard prices tokens), so this never ships a wrong price.
 */
export function summarizeUsage(usage: unknown): UsageSummary {
  const u = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  const details = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : {});
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const cached = num(details.cached_tokens);
  const total = num(u.total_tokens) || prompt + completion;
  const cached_pct = prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : 0;
  return { prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached, total_tokens: total, cached_pct };
}

/**
 * Pure per-call soft budget check (report-mode, never blocks). Returns true when a single call's
 * total tokens exceed the soft cap, so the gateway can EMIT an `over_soft_budget` flag that the
 * existing per-callsite cost monitors alert on. This is the observe-and-alert realization of "budget
 * caps": the gateway flags, the monitor pages, nothing is throttled in the hot path.
 */
export function overSoftBudget(summary: UsageSummary, softCapTokens = 60000): boolean {
  return summary.total_tokens > softCapTokens;
}

/**
 * Fire-and-forget capture to the PostHog ingestion endpoint. Never awaited by the caller,
 * never throws (env read is guarded), times out fast (1.5s), and no-ops when no key is
 * configured. All env access is wrapped so a missing/invalid env can never reach the hot path.
 */
export function captureGatewayEvent(
  event: string,
  properties: Record<string, unknown>,
  distinctId?: string,
): void {
  let key = '';
  let host = 'https://us.posthog.com';
  try {
    const env = loadEnv();
    key = env.POSTHOG_GATEWAYOPS_KEY;
    host = env.POSTHOG_HOST || host;
  } catch {
    return; // env not loadable in this context -> stay inert
  }
  const payload = buildCapturePayload(event, properties, distinctId, key);
  if (!payload) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  void fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
