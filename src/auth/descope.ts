/**
 * Descope Agentic Identity Hub -- OPTIONAL parallel credential path (Phase 2 pilot, 2026-07-08).
 *
 * Inert unless DESCOPE_PROJECT_ID is set. When configured, this accepts a Descope-issued RS256
 * session JWT (minted via POST /v1/auth/accesskey/exchange against a Descope Access Key created
 * in the Console/Management API) as an ADDITIONAL valid bearer credential for ONE pilot lane,
 * alongside -- not instead of -- the existing self-issued HS256 OAuth lanes in oauth-tokens.ts /
 * oauth.ts. Nothing about the existing credential paths changes.
 *
 * Pilot scope: ONLY a token whose `lane` custom claim is in DESCOPE_PILOT_LANES (default: just
 * "clo") is accepted, even if it is validly signed by Descope. This keeps the blast radius to
 * the one lane Matt approved for the pilot (see the "Descope (OTCHealth)" Hyperagent skill and
 * the Descope Living Document for full context and the Phase 1 provisioning proof).
 *
 * Signature verification is hand-rolled with node:crypto only (RS256 / RSASSA-PKCS1-v1_5), no
 * new npm dependency -- matching this repo's existing convention (see oauth-tokens.ts header:
 * "No external deps (node:crypto only)"). The JWKS is fetched once and cached in-memory for
 * JWKS_TTL_MS, so the common request path pays no network cost after the first verification.
 *
 * Per this repo's own testing convention (see oauth-tokens.test.ts's comment on the Cosmos auth
 * code path), the network-touching JWKS fetch is NOT unit tested -- only the pure signature/claim
 * verification logic is (descope.test.ts), using a locally generated RSA keypair. Live end-to-end
 * behavior is covered by manual smoke test against the real Descope pilot Access Key.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

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
  [key: string]: unknown;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour -- Descope signing keys rotate infrequently.

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

async function getKey(projectId: string, kid: string): Promise<KeyObject | null> {
  const now = Date.now();
  const stale =
    !jwksCache || jwksCache.projectId !== projectId || now - jwksCache.fetchedAt > JWKS_TTL_MS;
  if (stale || !jwksCache?.keys.has(kid)) {
    try {
      const keys = await fetchJwks(projectId);
      jwksCache = { keys, fetchedAt: now, projectId };
    } catch (err) {
      logger.warn({ type: 'descope_jwks_fetch_failed', err: String(err) }, 'Descope JWKS refresh failed');
      if (!jwksCache || jwksCache.projectId !== projectId) return null;
      // fall through to the stale cache below -- better than hard-failing on a transient blip
    }
  }
  return jwksCache?.keys.get(kid) ?? null;
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
 */
export async function verifyDescopeToken(token: string): Promise<DescopeClaims | null> {
  const env = loadEnv();
  if (!env.DESCOPE_PROJECT_ID) return null; // feature inert unless explicitly configured
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { kid?: string };
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')) as { kid?: string };
  } catch {
    return null;
  }
  if (!header.kid) return null;

  const key = await getKey(env.DESCOPE_PROJECT_ID, header.kid);
  if (!key) return null;

  const expectedIssuer = `https://api.descope.com/v1/apps/${env.DESCOPE_PROJECT_ID}`;
  return verifyDescopeClaims(token, new Map([[header.kid, key]]), expectedIssuer);
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
 * High-level entry point used by auth/bearer.ts: verify the token AND enforce the pilot lane
 * allow-list (defense in depth -- a validly-signed Descope token for an out-of-scope lane is
 * still rejected here). Returns the agent identity string (the `lane` claim, lowercased) or
 * null. Never throws.
 */
export async function agentFromDescopeToken(token: string): Promise<string | null> {
  const claims = await verifyDescopeToken(token);
  if (!claims) return null;
  const lane = String(claims.lane || '').toLowerCase();
  if (!lane || !pilotLanes().has(lane)) {
    logger.warn(
      { type: 'descope_lane_rejected', lane: lane || '(none)' },
      'Descope token verified but its lane is outside the pilot allow-list',
    );
    return null;
  }
  return lane;
}
