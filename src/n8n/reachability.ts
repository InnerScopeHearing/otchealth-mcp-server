/**
 * Shared n8n reachability gate for all four n8n clients (api-client.ts, write-client.ts,
 * full-client.ts, webhook-client.ts).
 *
 * WHY THIS EXISTS (2026-08-28). n8n has moved twice: n8n Cloud (otchealth.app.n8n.cloud) was
 * decommissioned first; the Azure self-host (automation.otchealth.app) that replaced it then died
 * with the permanently deleted Azure subscription 55c84f6b (2026-08-13), and its dangling DNS
 * record was removed 2026-08-27 (now NXDOMAIN). The successor is the AWS Lightsail recovery lane
 * (cs-n8n.otchealthmart.com, otchealth-cto/.github/workflows/aws-n8n-recovery.yml), which today
 * answers a FAST 502 (the reverse proxy is up; n8n itself is not yet running behind it) rather than
 * hanging or DNS-failing. That is a genuinely different failure shape from the previous NXDOMAIN
 * automation.otchealth.app produced, and it is the shape this gate exists to detect: a network
 * REJECTION (DNS failure, connection refused, timeout) and an HTTP response that is merely !res.ok
 * both mean "n8n is not usable right now" -- catching only the first would let every one of the 37
 * n8n_* tools keep emitting today's exact raw 502 straight through to the caller, unchanged, which
 * would defeat this gate on day one against the live host it was built for.
 *
 * Deleting the 37 n8n_* tools was considered and rejected: n8n returns once Lightsail recovery
 * completes, and re-adding them then would churn the catalog count and every lane allowlist twice
 * for no reason. A reachability gate reopens itself the moment cs-n8n.otchealthmart.com answers a
 * real 2xx on GET /healthz (n8n's own unauthenticated health endpoint) -- zero redeploy, zero code
 * change, unlike an env-flag kill switch which would need an operator to flip it back.
 *
 * Cached (both positive AND negative) for REACHABILITY_TTL_MS so a burst of tool calls does not
 * hammer n8n with one health probe per call. ONE shared cache across all four client files, not one
 * per file: there is exactly one n8n instance behind all four, and four independent caches would
 * quadruple the probe traffic and could disagree with each other for up to a TTL window.
 */
import { loadEnv } from '../config/env.js';

const REACHABILITY_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_500;

let cache: { ok: boolean; checkedAt: number } | null = null;

/** Test-only: force the next n8nReachable() call to re-probe instead of reusing a cached verdict. */
export function __resetN8nReachabilityCache(): void {
  cache = null;
}

/**
 * True when n8n itself is answering (not just the reverse proxy in front of it). A network
 * rejection OR a non-2xx response both resolve to false; only a genuine 2xx resolves to true, so
 * recovery is unambiguous and requires no operator action to detect.
 */
export async function n8nReachable(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.checkedAt < REACHABILITY_TTL_MS) return cache.ok;
  let ok: boolean;
  try {
    const base = loadEnv().N8N_BASE_URL.replace(/\/$/, '');
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  cache = { ok, checkedAt: now };
  return ok;
}

/**
 * The shared "n8n is offline" text every client's own N8n*Error subclass wraps in its own
 * constructor, so the message/nextStep/code cannot drift between the four independent copies.
 */
export const N8N_DEGRADED = {
  code: 'n8n_degraded',
  status: 503,
  message: 'n8n is offline. AWS Lightsail recovery is in progress (cs-n8n.otchealthmart.com).',
  nextStep: 'Check the recovery lane status: otchealth-cto, workflow aws-n8n-recovery.yml. This call will start working again automatically once n8n is reachable, no redeploy needed.',
} as const;
