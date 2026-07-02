/**
 * Agentless Datadog custom-metric emission for gateway LLM cost + prompt-cache observability.
 * Mirrors gateway-ops.ts: fire-and-forget, fail-open, and INERT BY DEFAULT (a no-op unless a key
 * is present). Uses DD_METRICS_API_KEY when set (so cost/cache metrics can be enabled WITHOUT
 * activating full APM, which instrument.ts gates on DD_API_KEY), else falls back to DD_API_KEY.
 *
 * Uses the Datadog HTTP metrics API (POST /api/v2/series) rather than DogStatsD, because the
 * Container App has no local Datadog agent/sidecar to receive UDP metrics; the HTTP submission
 * path works agentlessly with just the API key. The metric namespace otc.gateway.llm.* matches the
 * fleet's existing otc.* custom metrics already on the "OTCHealth Fleet — Models, Cost & Health"
 * dashboard, so the new cache-hit series sits naturally alongside them.
 *
 * DD_SITE must match the account region (us3.datadoghq.com for OTCHealth); it is read from the same
 * env dd-trace already uses, defaulting to datadoghq.com.
 */

export interface DdPoint {
  metric: string;
  value: number;
  /** Datadog metric type: 1=count, 2=rate, 3=gauge. Defaults to gauge. */
  type?: number;
  tags?: string[];
}

/**
 * Pure, testable: build the v2/series submission body, or null when there is nothing finite to
 * send. Non-finite values (NaN/Infinity) are dropped so a malformed usage object never emits junk.
 */
export function buildSeriesPayload(points: DdPoint[], nowSec = Math.floor(Date.now() / 1000)) {
  const clean = (points || []).filter((p) => p && typeof p.value === 'number' && Number.isFinite(p.value));
  if (!clean.length) return null;
  return {
    series: clean.map((p) => ({
      metric: p.metric,
      type: p.type ?? 3,
      points: [{ timestamp: nowSec, value: p.value }],
      tags: p.tags || [],
    })),
  };
}

/**
 * Pure: the three LLM metric points for one gateway call, tagged by model + task so the dashboard
 * can break down by either. cached_pct is a gauge (a rate at a point in time); the token counts are
 * counts (summable across calls into a token-weighted hit rate).
 */
export function llmMetricPoints(
  model: string,
  task: string,
  s: { prompt_tokens: number; cached_tokens: number; cached_pct: number },
): DdPoint[] {
  const tags = [`model:${model || 'unknown'}`, `task:${task || 'unknown'}`, 'service:gateway-mcp'];
  return [
    { metric: 'otc.gateway.llm.prompt_tokens', value: s.prompt_tokens, type: 1, tags },
    { metric: 'otc.gateway.llm.cached_tokens', value: s.cached_tokens, type: 1, tags },
    { metric: 'otc.gateway.llm.cached_pct', value: s.cached_pct, type: 3, tags },
  ];
}

/**
 * Fire-and-forget submission of the per-call LLM metrics. Never awaited, never throws, times out
 * fast (1.5s), and no-ops when DD_API_KEY is unset. Safe to call in the hot path.
 */
export function emitLlmMetrics(
  model: string,
  task: string,
  s: { prompt_tokens: number; cached_tokens: number; cached_pct: number },
): void {
  let key = '';
  let site = 'datadoghq.com';
  try {
    // Prefer a DEDICATED metrics key so custom-metric emission can be enabled WITHOUT turning on
    // full APM tracing (instrument.ts keys APM off DD_API_KEY). Falls back to DD_API_KEY when a
    // single key is used for both.
    key = process.env.DD_METRICS_API_KEY || process.env.DD_API_KEY || '';
    site = process.env.DD_SITE || site;
  } catch {
    return;
  }
  if (!key) return;
  const payload = buildSeriesPayload(llmMetricPoints(model, task, s));
  if (!payload) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  void fetch(`https://api.${site}/api/v2/series`, {
    method: 'POST',
    headers: { 'DD-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
