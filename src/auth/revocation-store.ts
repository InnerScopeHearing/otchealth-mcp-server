/**
 * In-memory runtime override for the active Perplexity connector token.
 *
 * The kill-switch (POST /admin/revoke) writes here. Bearer-auth middleware
 * checks here before accepting the env-configured token. Memory state, so a
 * process restart clears the revocation — by design. If a leaked token must
 * stay dead across restarts, rotate the env var, do not just hit /admin/revoke.
 */

import { hashToken } from '../audit/logger.js';

interface RevocationState {
  revoked_token_hash: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

const state: RevocationState = {
  revoked_token_hash: null,
  revoked_at: null,
  revoked_reason: null,
};

export function revokeToken(rawToken: string, reason: string): RevocationState {
  state.revoked_token_hash = hashToken(rawToken);
  state.revoked_at = new Date().toISOString();
  state.revoked_reason = reason;
  return { ...state };
}

export function isRevoked(rawToken: string): boolean {
  if (!state.revoked_token_hash) return false;
  return hashToken(rawToken) === state.revoked_token_hash;
}

export function getRevocationState(): RevocationState {
  return { ...state };
}

export function clearRevocation(): void {
  state.revoked_token_hash = null;
  state.revoked_at = null;
  state.revoked_reason = null;
}
