/**
 * OAuth 2.1 token primitives: stateless HS256 JWT access/refresh tokens + a short-lived
 * in-memory authorization-code store. No external deps (node:crypto only).
 *
 * Tokens are signed with OAUTH_TOKEN_SIGNING_SECRET so any replica validates without shared
 * state. The auth-code store is in-memory and short-lived (5 min); the gateway Container App
 * runs a single replica, so codes survive their TTL within one instance.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isConfigured as cosmosConfigured, createDoc, readDoc, deleteDoc } from '../agentstate/cosmos.js';

const AUD = 'otchealth-mcp';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string; // client_id
  scope: string;
  typ: 'access' | 'refresh';
  agent?: string;
  iat: number;
  exp: number;
  jti: string;
}

export function signToken(
  claims: Omit<AccessClaims, 'iat' | 'jti'> & { iat?: number; jti?: string },
  secret: string,
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const full: AccessClaims = {
    iat: now,
    jti: randomBytes(12).toString('hex'),
    ...claims,
  } as AccessClaims;
  const payload = b64url(JSON.stringify(full));
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verify signature + expiry + audience. Returns claims or null. Never throws. */
export function verifyToken(token: string, secret: string): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  if (!safeEqualStr(sig, expected)) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AccessClaims;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || now >= claims.exp) return null;
  if (claims.aud !== AUD) return null;
  return claims;
}

export function issueAccessToken(clientId: string, scope: string, secret: string, baseUrl: string, agent = '', ttlSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ iss: baseUrl, aud: AUD, sub: clientId, scope, agent, typ: 'access', exp: now + ttlSeconds }, secret);
}

export function issueRefreshToken(clientId: string, scope: string, secret: string, baseUrl: string, agent = '', ttlSeconds = 60 * 60 * 24 * 30): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ iss: baseUrl, aud: AUD, sub: clientId, scope, agent, typ: 'refresh', exp: now + ttlSeconds }, secret);
}

// ── Authorization-code store: Cosmos-backed when configured, in-memory fallback ──
//
// OAuth 2.1 requires the authorization code to be single-use, which is inherently STATEFUL
// (unlike the access/refresh tokens above, which are stateless HS256 JWTs any replica can
// verify). If the /authorize request and its /token exchange land on different replicas, or
// straddle a blue-green revision cutover, an in-memory-only code is lost. So when Cosmos is
// configured the code lives in the shared `oauthcodes` container (partition key = the code
// itself, so every lookup is a point read); Cosmos native per-item TTL is the expiry backstop
// and the explicit expiresAt check covers TTL's best-effort deletion lag. With no Cosmos
// (tests / local dev) it falls back to an in-memory Map with a sweeper, exactly as before.
const CODES_CONTAINER = 'oauthcodes';

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  expiresAt: number;
}

const authCodes = new Map<string, AuthCodeRecord>();

setInterval(() => {
  const now = Date.now();
  for (const [code, rec] of authCodes) if (rec.expiresAt < now) authCodes.delete(code);
}, 60_000).unref?.();

export async function createAuthCode(
  rec: Omit<AuthCodeRecord, 'expiresAt'>,
  ttlMs = 5 * 60 * 1000,
): Promise<string> {
  const code = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  if (cosmosConfigured()) {
    // ttl is a backstop slightly past logical expiry; expiresAt is the authoritative check.
    await createDoc(CODES_CONTAINER, code, { id: code, ...rec, expiresAt, ttl: Math.ceil(ttlMs / 1000) + 60 });
  } else {
    authCodes.set(code, { ...rec, expiresAt });
  }
  return code;
}

/** One-time consume: returns the record and deletes it. Null if missing/expired/malformed. */
export async function consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
  if (cosmosConfigured()) {
    let found: { doc: Record<string, unknown> } | null;
    try {
      // A malformed code trips the Cosmos id-charset guard (throws) -> treat as invalid_grant.
      found = await readDoc(CODES_CONTAINER, code, code);
    } catch {
      return null;
    }
    if (!found) return null;
    try {
      await deleteDoc(CODES_CONTAINER, code, code); // enforce single-use; ignore if already gone
    } catch {
      /* best-effort */
    }
    const d = found.doc as unknown as AuthCodeRecord;
    if (!d.expiresAt || d.expiresAt < Date.now()) return null;
    return {
      clientId: d.clientId,
      redirectUri: d.redirectUri,
      scope: d.scope,
      codeChallenge: d.codeChallenge,
      codeChallengeMethod: d.codeChallengeMethod,
      expiresAt: d.expiresAt,
    };
  }
  const rec = authCodes.get(code);
  if (!rec) return null;
  authCodes.delete(code);
  if (rec.expiresAt < Date.now()) return null;
  return rec;
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const hash = createHash('sha256').update(verifier).digest('base64url');
  return safeEqualStr(hash, challenge);
}
