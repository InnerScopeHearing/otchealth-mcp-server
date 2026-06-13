/**
 * Per-client OAuth access tokens (issued at the token endpoint, validated at /mcp).
 *
 * Lives in its own module so both auth/bearer.ts (validation) and server/oauth.ts
 * (minting) can use it without a circular import. In-memory + bounded: tokens are
 * lost on restart, so OAuth clients re-run the (cheap) flow after a redeploy; the
 * static connector bearer is unaffected and remains the durable path for
 * bearer-direct clients (Perplexity / Claude Code).
 *
 * Why per-client tokens (vs. handing out the master connector token): real
 * per-client revocation, real audit attribution (distinct caller hash), and a
 * server-enforced expiry instead of an advertised-but-fake one.
 */
import { randomBytes } from 'node:crypto';

interface IssuedToken {
  clientId: string;
  expiresAt: number;
}

const tokens = new Map<string, IssuedToken>();
const MAX_TOKENS = 2000;

export function mintAccessToken(clientId: string, ttlMs: number): { token: string; expiresInSeconds: number } {
  const now = Date.now();
  // Opportunistic eviction so an attacker who completes the consent flow cannot
  // grow this unboundedly: drop expired, then the soonest-expiring if still full.
  if (tokens.size >= MAX_TOKENS) {
    for (const [k, v] of tokens) if (v.expiresAt < now) tokens.delete(k);
    while (tokens.size >= MAX_TOKENS) {
      let oldestKey: string | undefined;
      let oldestExp = Infinity;
      for (const [k, v] of tokens) {
        if (v.expiresAt < oldestExp) {
          oldestExp = v.expiresAt;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      tokens.delete(oldestKey);
    }
  }
  const token = `oat_${randomBytes(32).toString('hex')}`;
  tokens.set(token, { clientId, expiresAt: now + ttlMs });
  return { token, expiresInSeconds: Math.floor(ttlMs / 1000) };
}

/** Returns the issued-token record if present + unexpired, else null (and evicts). */
export function lookupAccessToken(token: string): IssuedToken | null {
  const t = tokens.get(token);
  if (!t) return null;
  if (t.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return t;
}

export function revokeAccessToken(token: string): boolean {
  return tokens.delete(token);
}

export function sweepAccessTokens(): void {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expiresAt < now) tokens.delete(k);
}

/** Test/introspection helper. */
export function accessTokenCount(): number {
  return tokens.size;
}
