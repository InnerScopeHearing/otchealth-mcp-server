/**
 * Descope Agentic Identity Hub -- OPTIONAL parallel credential path (Phase 2 pilot, 2026-07-08).
 *
 * Inert unless DESCOPE_PROJECT_ID is set. When configured, this accepts a Descope-issued RS256
 * session JWT as an ADDITIONAL valid bearer credential for approved pilot lanes, alongside --
 * not instead of -- the existing self-issued HS256 OAuth lanes in oauth-tokens.ts / oauth.ts.
 * Nothing about the existing credential paths changes.
 *
 * TWO Descope-side credential mechanisms are both accepted here, resolved to a lane via TWO
 * different claim paths on the same verified JWT:
 *
 * 1. Access Keys (minted via POST /v1/mgmt/accesskey/create, exchanged via
 *    POST /v1/auth/accesskey/exchange) -- carry an explicit `lane` custom claim set at Access
 *    Key creation time. This was the original (2026-07-08 Phase 2) pilot mechanism.
 *
 * 2. Inbound App Clients (minted via POST /v1/mgmt/thirdparty/app/create, token issued via
 *    POST /oauth2/v1/apps/token with the standard OAuth2 client_credentials grant) -- carry NO
 *    `lane` claim; instead they carry a standard OAuth `scope` string. Added 2026-07-08 (later
 *    the same day) once we discovered Inbound App Clients are the object type that populates
 *    Descope's "Agentic Identity" Console dashboard (Access Keys do not). A scope is mapped to
 *    a lane via DESCOPE_SCOPE_LANE_MAP (or the built-in default below, matching the 3 real
 *    Inbound App Clients provisioned that day). If a token's scope string maps to MORE THAN ONE
 *    distinct lane, it is rejected as ambiguous rather than silently picking one -- a Client
 *    ever granted multiple mapped scopes must not be able to pick its own privilege level.
 *
 * Pilot scope: regardless of which claim resolves a lane, the result MUST also be in
 * DESCOPE_PILOT_LANES (default: just "clo") to be accepted -- this is the actual blast-radius
 * control, checked once, downstream of both resolution paths (defense in depth). See the
 * "Descope (OTCHealth)" Hyperagent skill and the Descope Living Document for full context and
 * the live provisioning/testing history for both mechanisms.
 *
 * Signature verification is hand-rolled with node:crypto only (RS256 / RSASSA-PKCS1-v1_5), no
 * new npm dependency -- matching this repo's existing convention (see oauth-tokens.ts header:
 * "No external deps (node:crypto only)"). The JWKS is fetched once and cached in-memory for
 * JWKS_TTL_MS, so the common request path pays no network cost after the first verification.
 * Both mechanisms above share the EXACT SAME issuer + JWKS signing key (confirmed live,
 * 2026-07-08), so no change was needed to the JWKS-fetch/verify code itself for mechanism 2 --
 * only to lane resolution, below.
 *
 * Per this repo's own testing convention (see oauth-tokens.test.ts's comment on the Cosmos auth
 * code path), the network-touching JWKS fetch is NOT unit tested -- only the pure signature/claim
 * verification logic is (descope.test.ts), using a locally generated RSA keypair. Live end-to-end
 * behavior is covered by manual smoke test against real Descope pilot credentials (both an
 * Access Key and an Inbound App Client).
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { captureGatewayEvent } from '../telemetry/gateway-ops.js';

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

export interface DescopeClaims {
  iss: string;
  sub: string;
  exp: number;
  lane?: string;
  ring?: string;
  pilot?: boolean;
  scope?: string;
  [key: string]: unknown;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour -- Descope signing keys rotate infrequently.

// Built-in fallback for the 3 real Inbound App Clients provisioned 2026-07-08. Overridable
// (widenable or replaceable) via DESCOPE_SCOPE_LANE_MAP without a redeploy -- a JSON object
// string, e.g. {"mcp:legal.read":"clo"}. An empty/malformed env value falls back to this default
// rather than going inert, since these 3 mappings are already live and provisioned.
const DEFAULT_SCOPE_LANE_MAP: Record<string, string> = {
  'mcp:legal.read': 'clo',
  'mcp:legal.personal.read': 'clo-personal',
  'mcp:infra.admin': 'cto',
};

let jwksCache: { keys: Map<string, KeyObject>; fetchedAt: number; projectId: string } | null = null;

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function jwksUrl(projectId: string): string {
  // Confirmed live 2026-07-07: https://api.descope.com/{projectId}/.well-known/jwks.json
  // (NOT under /v1/apps/ -- that path is the token `iss` value, a different, also-valid URL).
  return `https://api.descope.com/${projectId}/.well-known/jwks.json`;
}

/** Fetches and parses a Descope project's JWKS into a Map<kid, KeyObject>. Network call. */
export async function fetchJwks(projectId: string): Promise<Map<string, KeyObject>> {
  const res = await fetch(jwksUrl(projectId));
  if (!res.ok) throw new Error(`descope jwks fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const map = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    try {
      map.set(jwk.kid, createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' }));
    } catch {
      /* skip a malformed/unsupported key rather than failing the whole set */
    }
  }
  return map;
}

/**
 * Resolves a signing key, OR reports whether a null result means "Descope infrastructure could not
 * be reached AND that outage is why this specific key could not be resolved" (infraFailure: true)
 * versus ordinary credential rejection (infraFailure: false). This distinction is what lets
 * verifyDescopeToken's telemetry (below) separate genuine Descope-infrastructure unreliability from
 * ordinary credential rejection (see that function's TELEMETRY doc comment for why conflating the two
 * would misreport hostile/malformed traffic as Descope downtime).
 *
 * infraFailure is true in exactly one shape: a refetch was attempted THIS call (because the cache was
 * stale or missing this kid — e.g. a legitimate token signed just after a key rotation) AND that
 * refetch failed AND the resulting key still cannot be resolved (not even from a stale cache).
 * Reviewer-caught correctness fix (2026-07-30): the prior version unconditionally returned
 * infraFailure:false on the "fall through to the stale cache" path, INCLUDING when the fallback
 * cache didn't have the requested kid either — so a genuinely valid post-rotation token, arriving
 * during a real JWKS outage, was misreported as credential_rejected instead of jwks_unavailable,
 * undercounting the exact reliability failures this telemetry exists to measure. A refetch that
 * fails but still resolves the key from an already-warm, still-usable stale cache (e.g. TTL-expired
 * but same key set) correctly stays infraFailure:false — that is a degraded-but-functioning path,
 * not an outage from the caller's perspective.
 */
async function getKey(projectId: string, kid: string): Promise<{ key: KeyObject | null; infraFailure: boolean }> {
  const now = Date.now();
  const stale =
    !jwksCache || jwksCache.projectId !== projectId || now - jwksCache.fetchedAt > JWKS_TTL_MS;
  let refetchFailed = false;
  if (stale || !jwksCache?.keys.has(kid)) {
    try {
      const keys = await fetchJwks(projectId);
      jwksCache = { keys, fetchedAt: now, projectId };
    } catch (err) {
      logger.warn({ type: 'descope_jwks_fetch_failed', err: String(err) }, 'Descope JWKS refresh failed');
      refetchFailed = true;
      if (!jwksCache || jwksCache.projectId !== projectId) {
        return { key: null, infraFailure: true }; // no fetch succeeded, ever, for this project -- a real infra failure
      }
      // fall through to the stale cache below; infraFailure is now decided by whether that stale
      // cache actually resolves the key we need, not hardcoded false.
    }
  }
  const key = jwksCache?.keys.get(kid) ?? null;
  return { key, infraFailure: refetchFailed && key === null };
}

/**
 * Pure signature + claim verification against an already-resolved key set. No network. This is
 * the unit-tested core (descope.test.ts uses a locally generated RSA keypair here).
 */
export function verifyDescopeClaims(
  token: string,
  keys: Map<string, KeyObject>,
  expectedIssuer: string,
): DescopeClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string };
  let claims: DescopeClaims;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8')) as { alg?: string; kid?: string };
    claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as DescopeClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  if (claims.iss !== expectedIssuer) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || now >= claims.exp) return null;

  const key = keys.get(header.kid);
  if (!key) return null;

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  let sig: Buffer;
  try {
    sig = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  let ok = false;
  try {
    ok = cryptoVerify('RSA-SHA256', signingInput, key, sig);
  } catch {
    return null;
  }
  return ok ? claims : null;
}

/**
 * Full verification path: fetches (or reuses cached) JWKS for the configured project, then
 * verifies the token against it. Returns null (never throws) if Descope isn't configured, the
 * token is malformed, signature is invalid, expired, or issued by a different project.
 *
 * TELEMETRY (added 2026-07-30, ADR-002 section 6 trigger 4 -- "the parallel path has run in
 * production long enough to measure real latency/reliability data, rather than relying on
 * estimates"): before this, NOTHING in the codebase distinguished "this request authenticated via
 * Descope" from any other auth path, anywhere downstream -- auth/bearer.ts computes the Descope
 * branch locally and discards which path resolved the caller once caller_agent is derived, and
 * every existing PostHog gw_* event (gw_mutation, gw_lane_tool_used, gw_checkpoint) carries
 * caller/tool data, never auth-provider timing or outcome (confirmed by reading every
 * captureGatewayEvent call site, AND by querying the live Gateway Ops project 493944 directly:
 * zero events, zero properties, reference Descope in any form). So trigger 4 could not be fired
 * from existing data; it needed instrumentation FIRST, exactly as flagged in review. This wraps
 * the ACTUAL Descope-infrastructure boundary (JWKS fetch + RSA signature verification, i.e. real
 * network + crypto latency), not the whole bearer-auth function (which is near-instant for every
 * non-Descope path and would dilute the signal), and fires ONLY when DESCOPE_PROJECT_ID is
 * configured (the feature's own existing "inert unless configured" convention -- an unconfigured
 * pilot emits nothing, so this cannot generate noise before the pilot exists). Fire-and-forget,
 * fail-open, mirrors every other captureGatewayEvent call site in this codebase: telemetry can
 * never affect the auth decision it rides on.
 *
 * `outcome` is a 3-way classification, NOT a bare verified/failed boolean (fixed 2026-07-30 review:
 * a single `failed` bucket cannot measure reliability -- auth/bearer.ts sends every non-issued,
 * three-segment-shaped bearer token through this function, so `failed` would have conflated a real
 * Descope-infrastructure outage with ordinary malformed/hostile/expired/wrong-signature client
 * traffic, making invalid credentials LOOK like provider downtime on the dashboard):
 *   - 'verified'            -- signature, issuer, and expiry all checked out.
 *   - 'credential_rejected' -- Descope's infrastructure was reachable and did its job; the TOKEN
 *                              itself is bad (malformed, expired, wrong issuer/signature, unknown
 *                              kid in a successfully-fetched key set). Not a reliability signal.
 *   - 'jwks_unavailable'    -- the JWKS fetch itself failed AND there was no usable cached key set to
 *                              fall back on (see getKey's infraFailure). THE actual reliability
 *                              signal Trigger 4 cares about -- compute latency/reliability from this
 *                              bucket alone, never from credential_rejected.
 * This is a SEPARATE classification from the "verified but lane outside DESCOPE_PILOT_LANES" refusal,
 * which agentFromDescopeToken (the caller one layer up) already logs on its own via
 * descope_lane_rejected -- that is pilot-scope POLICY, decided after a successful 'verified' outcome
 * here, not a verification failure at all.
 */
export async function verifyDescopeToken(token: string): Promise<DescopeClaims | null> {
  const env = loadEnv();
  if (!env.DESCOPE_PROJECT_ID) return null; // feature inert unless explicitly configured; no telemetry
  const startedAt = Date.now();
  const result = await verifyDescopeTokenUninstrumented(token, env.DESCOPE_PROJECT_ID);
  try {
    captureGatewayEvent('gw_descope_auth', {
      outcome: result.outcome,
      latency_ms: Date.now() - startedAt,
    });
  } catch {
    // Fail-open: telemetry must never affect the auth decision it rides on.
  }
  return result.claims;
}

export type DescopeVerifyOutcome = 'verified' | 'credential_rejected' | 'jwks_unavailable';

interface DescopeVerifyResult {
  claims: DescopeClaims | null;
  outcome: DescopeVerifyOutcome;
}

/** The actual JWKS-fetch + signature-verification work, extracted so verifyDescopeToken above can
 * wrap it with timing/telemetry without duplicating the logic. Not exported; verifyDescopeToken
 * is the only sanctioned entry point (matches this file's existing single-entry-point convention
 * for agentFromDescopeToken). Returns BOTH the claims (for the public contract) and the 3-way
 * outcome classification (for telemetry) -- see verifyDescopeToken's TELEMETRY doc comment above. */
async function verifyDescopeTokenUninstrumented(token: string, projectId: string): Promise<DescopeVerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { claims: null, outcome: 'credential_rejected' };
  let header: { kid?: string };
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as { kid?: string };
  } catch {
    return { claims: null, outcome: 'credential_rejected' };
  }
  if (!header.kid) return { claims: null, outcome: 'credential_rejected' };

  const { key, infraFailure } = await getKey(projectId, header.kid);
  if (!key) return { claims: null, outcome: infraFailure ? 'jwks_unavailable' : 'credential_rejected' };

  const expectedIssuer = `https://api.descope.com/v1/apps/${projectId}`;
  const claims = verifyDescopeClaims(token, new Map([[header.kid, key]]), expectedIssuer);
  return { claims, outcome: claims ? 'verified' : 'credential_rejected' };
}

/** The pilot lane allow-list. Defaults to just "clo" -- the one lane approved for this pilot. */
function pilotLanes(): Set<string> {
  const env = loadEnv();
  const raw = env.DESCOPE_PILOT_LANES || 'clo';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The scope->lane map for Inbound App Client tokens (mechanism 2 -- see file header). Reads
 * DESCOPE_SCOPE_LANE_MAP (a JSON object string) fresh each call so it can be widened without a
 * redeploy; falls back to DEFAULT_SCOPE_LANE_MAP if unset or malformed, since 3 real Inbound App
 * Clients already depend on that default being active.
 */
function scopeLaneMap(): Record<string, string> {
  const env = loadEnv();
  const raw = env.DESCOPE_SCOPE_LANE_MAP;
  if (!raw) return DEFAULT_SCOPE_LANE_MAP;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* malformed JSON -- fall back to the default rather than going inert */
  }
  return DEFAULT_SCOPE_LANE_MAP;
}

/**
 * Resolves a lane from a token's `scope` claim (space-separated OAuth scope string) via
 * scopeLaneMap(). Returns null if there's no scope claim, no scope maps to a known lane, OR the
 * scopes present map to MORE THAN ONE distinct lane (ambiguous -- rejected rather than guessed).
 * Exported for direct hermetic unit testing (descope.test.ts) -- reads DESCOPE_SCOPE_LANE_MAP via
 * loadEnv() each call, so tests toggle behavior by setting process.env before calling.
 */
export function laneFromScope(scope: unknown): string | null {
  if (typeof scope !== 'string' || !scope.trim()) return null;
  const map = scopeLaneMap();
  const scopes = scope.split(/\s+/).filter(Boolean);
  const mappedLanes = new Set(
    scopes.map((s) => map[s]).filter((l): l is string => typeof l === 'string' && l.length > 0),
  );
  if (mappedLanes.size === 0) return null;
  if (mappedLanes.size > 1) {
    logger.warn(
      { type: 'descope_scope_ambiguous', scopes, mappedLanes: [...mappedLanes] },
      'Descope token scope maps to multiple distinct lanes; rejecting as ambiguous',
    );
    return null;
  }
  return [...mappedLanes][0].toLowerCase();
}

/**
 * High-level entry point used by auth/bearer.ts: verify the token AND enforce the pilot lane
 * allow-list (defense in depth -- a validly-signed Descope token for an out-of-scope lane is
 * still rejected here). Resolves a lane from either the `lane` custom claim (Access-Key-exchange
 * tokens) or, failing that, the `scope` claim (Inbound App Client / client_credentials tokens --
 * see file header for why there are two mechanisms). Returns the agent identity string
 * (lowercased) or null. Never throws.
 */
export async function agentFromDescopeToken(token: string): Promise<string | null> {
  const claims = await verifyDescopeToken(token);
  if (!claims) return null;

  const laneClaim = String(claims.lane || '').toLowerCase();
  const lane = laneClaim || laneFromScope(claims.scope);

  if (!lane || !pilotLanes().has(lane)) {
    logger.warn(
      { type: 'descope_lane_rejected', lane: lane || '(none)' },
      'Descope token verified but its lane is outside the pilot allow-list',
    );
    return null;
  }
  return lane;
}
