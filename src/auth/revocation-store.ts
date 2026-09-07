/**
 * Durable token-revocation blocklist for the gateway kill-switch (POST /admin/revoke, ADR-001 Section 6).
 *
 * WHY DURABLE (2026-07-16): the original store held ONE token hash in a module variable, so (a) a
 * process restart / blue-green redeploy CLEARED the revocation, and (b) revoking a second token
 * OVERWROTE the first. A real leaked developer-lane JWT (iheartest commit def9e234a, exp 2026-12-31)
 * therefore could not be permanently killed by /admin/revoke alone -- the one-off revoke workflow ran,
 * "succeeded" against a live revision, and evaporated on the next deploy. This closes that gap.
 *
 * DESIGN: an in-memory Set<hash> is the hot-path check (isRevoked stays sync + allocation-light; it runs
 * on EVERY request in auth/bearer.ts, so it must not do IO). Each revoke is WRITE-THROUGH to the selected
 * agent-state backend (one doc per revoked hash) so it survives restarts. The set is loaded at boot via
 * loadRevocations(). No state-store read is on the request path. Static authentication stays closed until
 * the first complete durable read succeeds. Memory-only operation requires an explicit non-production
 * selector. Only token HASHES are stored, never a raw token.
 */

import { isConfigured as stateConfigured, upsertDoc, queryDocs } from '../agentstate/store.js';
import {
  TokenRevocationStore,
  type RevocationResult,
  type RevocationState,
  type RevocationStoreStatus,
} from './revocation-store-core.js';

// The `cache` container's partition key path is /cacheScope (see tools/result-store.ts, which sets
// cacheScope = id so each doc is its own partition -> a point read/write). We mirror that: one doc per
// revoked hash, cacheScope = id = `revoked_<hash>` (charset-safe for the Cosmos id allowlist).
const CACHE_COLL = 'cache';
const REVOKED_KIND = 'revoked-token';
const idFor = (hash: string): string => `revoked_${hash}`;
const MAX_ROWS = 1000;
const parsedMaxStaleMs = Number(process.env.REVOCATION_MAX_STALE_MS);
const MAX_STALE_MS = Number.isFinite(parsedMaxStaleMs) && parsedMaxStaleMs >= 0
  ? parsedMaxStaleMs
  : 300_000;

function allowMemoryOnly(): boolean {
  return (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
    && process.env.REVOCATION_MEMORY_ONLY_MODE === 'development';
}

const store = new TokenRevocationStore({
  isConfigured: stateConfigured,
  query: () => queryDocs(
    CACHE_COLL,
    'SELECT c.hash, c.revoked_at, c.revoked_reason FROM c WHERE c.kind = @k',
    [{ name: '@k', value: REVOKED_KIND }],
    // Request one extra row so a capped response is detected and rejected as incomplete.
    { max: MAX_ROWS + 1 },
  ),
  upsert: async (hash, at, reason) => {
    await upsertDoc(CACHE_COLL, idFor(hash), {
      id: idFor(hash),
      cacheScope: idFor(hash),
      kind: REVOKED_KIND,
      hash,
      revoked_at: at,
      revoked_reason: reason,
    });
  },
}, {
  allowMemoryOnly,
  maxRows: MAX_ROWS,
  maxStaleMs: MAX_STALE_MS,
});

/**
 * Load the durable blocklist into memory at process start. A failed initial read leaves static-token
 * authentication unavailable; a successful empty result makes it ready. Returns the in-memory count.
 */
export async function loadRevocations(): Promise<number> {
  return store.load();
}

/**
 * Revoke a token by hash. It is rejected on this replica immediately, then written through to the
 * durable backend. The result distinguishes confirmed persistence from a failed write so the admin
 * route cannot claim fleet-wide or restart-safe revocation until persistence succeeds. Reissuing the
 * same revoke retries its per-hash upsert without replacing any other revoked hash.
 */
export async function revokeToken(rawToken: string, reason: string): Promise<RevocationResult> {
  return store.revoke(rawToken, reason);
}

/** Hot-path revocation check. Sync + IO-free (in-memory Set), safe to run on every request. */
export function isRevoked(rawToken: string): boolean {
  return store.isRevoked(rawToken);
}

export function getRevocationState(): RevocationState {
  return store.state();
}

export function getRevocationStoreStatus(): RevocationStoreStatus {
  return store.status();
}

export function isStaticTokenAuthReady(): boolean {
  return store.status().static_token_auth_ready;
}

/**
 * Clear revocations only in an explicitly selected local development memory mode.
 * Durable clear is disabled until a versioned tombstone protocol can converge every replica.
 */
export async function clearRevocation() {
  return store.clear();
}

// ── Multi-replica propagation ──────────────────────────────────────────────────────────────────────
// The gateway runs behind Front Door / APIM and can serve from MORE THAN ONE replica. A /admin/revoke
// lands on exactly ONE replica: it updates that replica's in-memory set + persistence, but other replicas
// keep their stale set until they reboot. Verified live 2026-07-16: right after a single revoke, the
// leaked token was still HTTP 200 on ~half of requests. So each replica periodically re-pulls the durable
// blocklist from persistence, making any revoke fleet-wide within one interval with NO restart and no manual
// fan-out. loadRevocations() is add-only (never un-revokes on a transient empty read -> fail-SAFE for a
// kill-switch). Durable clear is disabled because additive reload cannot safely propagate an un-revoke;
// that needs a separately reviewed versioned tombstone protocol. Cheap: one tiny kind-filtered query.
const RELOAD_MS = Number(process.env.REVOCATION_RELOAD_MS) || 30_000;
let _reloadTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic state-store reconciler (idempotent; only with configured persistence). */
export function startRevocationReloader(): void {
  if (_reloadTimer || !getRevocationStoreStatus().persistence_configured) return;
  _reloadTimer = setInterval(() => {
    void loadRevocations();
  }, RELOAD_MS);
  // Do not keep the event loop alive just for this timer.
  (_reloadTimer as unknown as { unref?: () => void }).unref?.();
}

/** Stop the reconciler (test teardown / graceful shutdown). */
export function stopRevocationReloader(): void {
  if (_reloadTimer) {
    clearInterval(_reloadTimer);
    _reloadTimer = null;
  }
}
