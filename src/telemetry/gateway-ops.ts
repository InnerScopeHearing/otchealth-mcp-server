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
 * Pure, testable: build the PostHog capture body, or null when telemetry is disabled
 * (no key). No IO. The key is a parameter (defaulting to the env value) so tests can
 * exercise both the enabled and inert paths deterministically.
 */
export function buildCapturePayload(
  event: string,
  properties: Record<string, unknown>,
  distinctId?: string,
  key: string = loadEnv().POSTHOG_GATEWAYOPS_KEY,
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

/**
 * Fire-and-forget capture to the PostHog ingestion endpoint. Never awaited by the caller,
 * never throws, times out fast (1.5s), and no-ops when no key is configured.
 */
export function captureGatewayEvent(
  event: string,
  properties: Record<string, unknown>,
  distinctId?: string,
): void {
  const payload = buildCapturePayload(event, properties, distinctId);
  if (!payload) return;
  const host = loadEnv().POSTHOG_HOST || 'https://us.posthog.com';
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
