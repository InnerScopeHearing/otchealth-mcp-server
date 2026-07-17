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

/** Caller-assigned latency bucket for a single LLM (or cache-served) call, used to slice p95 by
 * call kind on the dashboard: 'hot' for a user-blocking interactive call, 'background' for a
 * fire-and-forget/best-effort call, 'normal' for everything else (the default). */
export type LatencyClass = 'hot' | 'normal' | 'background';

export interface LatencyFields {
  duration_ms: number;
  /** Time-to-first-token. Present ONLY when the caller genuinely measured a streaming response. */
  ttft_ms?: number;
  cache_hit: boolean;
  cached_pct: number;
  model: string;
  latency_class: LatencyClass;
}

/**
 * Pure, env-free, no Date.now() inside: build the latency + cache telemetry fields for one LLM
 * call (or a cache-served response standing in for one), to spread into a gateway_llm_call /
 * gateway_llm_cache_hit capture's properties. The caller measures `startedAt`/`endedAt` (usually
 * bracketing just the chat() call, or the cache lookup) so this stays deterministic and provable
 * without network or a real clock, see gateway-ops.test.ts.
 *
 * `ttftMs` is included ONLY when the caller genuinely measured a time-to-first-token (a streaming
 * response); omitted otherwise rather than defaulted to 0 or to duration_ms, so an absent field on
 * the dashboard always means "not observed," never "instant." Foundry's chat() (azure/foundry.ts)
 * has no streaming mode today, so no current caller can supply a real ttftMs, this stays wired
 * for when one exists.
 *
 * `cachedPct` is a pass-through (reuse summarizeUsage's cached_pct, do not recompute it here) and
 * defaults to 0 when the caller has no usage object to derive it from (e.g. a cache-served
 * response with no fresh token usage). `latencyClass` defaults to 'normal' when the caller does
 * not tag the call.
 */
export function buildLatencyFields(opts: {
  startedAt: number;
  endedAt: number;
  model: string;
  cacheHit: boolean;
  cachedPct?: number;
  ttftMs?: number;
  latencyClass?: LatencyClass;
}): LatencyFields {
  const fields: LatencyFields = {
    duration_ms: Math.max(0, opts.endedAt - opts.startedAt),
    cache_hit: opts.cacheHit,
    cached_pct: opts.cachedPct ?? 0,
    model: opts.model,
    latency_class: opts.latencyClass ?? 'normal',
  };
  if (typeof opts.ttftMs === 'number' && Number.isFinite(opts.ttftMs)) {
    fields.ttft_ms = opts.ttftMs;
  }
  return fields;
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
