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
 * on EVERY request in auth/bearer.ts, so it must not do IO). Each revoke is WRITE-THROUGH to Cosmos (the
 * already-provisioned shared `cache` container, one doc per revoked hash) so it survives restarts, and
 * the set is LOADED back from Cosmos at boot via loadRevocations() (called from server startup). No Cosmos
 * read is ever on the request path. With no Cosmos configured (tests / local dev) it degrades to
 * in-memory-only, exactly as the original did. Only token HASHES are ever stored, never a raw token.
 */

import { hashToken } from '../audit/logger.js';
import { isConfigured as cosmosConfigured, upsertDoc, deleteDoc, queryDocs } from '../agentstate/store.js';

// The `cache` container's partition key path is /cacheScope (see tools/result-store.ts, which sets
// cacheScope = id so each doc is its own partition -> a point read/write). We mirror that: one doc per
// revoked hash, cacheScope = id = `revoked_<hash>` (charset-safe for the Cosmos id allowlist).
const CACHE_COLL = 'cache';
const REVOKED_KIND = 'revoked-token';
const idFor = (hash: string): string => `revoked_${hash}`;

interface RevocationState {
  revoked_token_hash: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

// Hot-path source of truth: the set of revoked token HASHES. isRevoked() reads only this.
const revokedHashes = new Set<string>();
// Back-compat single "most recent revocation" view for /health + the /admin GET/response shape.
let latest: RevocationState = { revoked_token_hash: null, revoked_at: null, revoked_reason: null };

/**
 * Load the durable blocklist into memory at process start. Idempotent and FAIL-OPEN: a Cosmos hiccup
 * must never brick boot -- the set simply starts from whatever loads, and any /admin/revoke re-adds
 * durably. Returns the number of hashes now in the set. Call once from server startup.
 */
export async function loadRevocations(): Promise<number> {
  if (!cosmosConfigured()) return revokedHashes.size;
  try {
    const rows = await queryDocs(
      CACHE_COLL,
      'SELECT c.hash, c.revoked_at, c.revoked_reason FROM c WHERE c.kind = @k',
      [{ name: '@k', value: REVOKED_KIND }],
      { max: 1000 },
    );
    let newestAt = '';
    for (const r of rows) {
      const rec = r as { hash?: unknown; revoked_at?: unknown; revoked_reason?: unknown };
      if (typeof rec.hash === 'string' && rec.hash) {
        revokedHashes.add(rec.hash);
        const at = typeof rec.revoked_at === 'string' ? rec.revoked_at : '';
        // ISO-8601 strings sort lexicographically by time, so ">" picks the newest revocation.
        if (at > newestAt) {
          newestAt = at;
          latest = {
            revoked_token_hash: rec.hash,
            revoked_at: at || null,
            revoked_reason: typeof rec.revoked_reason === 'string' ? rec.revoked_reason : null,
          };
        }
      }
    }
    return revokedHashes.size;
  } catch {
    return revokedHashes.size; // fail-open: never throw on boot
  }
}

/**
 * Revoke a token by hash, permanently. Adds to the hot-path set AND write-throughs to Cosmos so the
 * revocation survives restarts/redeploys. FAIL-OPEN on the durable write: a Cosmos blip must not turn a
 * security revoke into a hard error (the token is already rejected on the live revision the moment the
 * set is updated); re-issuing /admin/revoke re-attempts the durable write. Returns the latest state.
 */
export async function revokeToken(rawToken: string, reason: string): Promise<RevocationState> {
  const h = hashToken(rawToken);
  const at = new Date().toISOString();
  revokedHashes.add(h);
  latest = { revoked_token_hash: h, revoked_at: at, revoked_reason: reason };
  if (cosmosConfigured()) {
    try {
      await upsertDoc(CACHE_COLL, idFor(h), {
        id: idFor(h),
        cacheScope: idFor(h),
        kind: REVOKED_KIND,
        hash: h,
        revoked_at: at,
        revoked_reason: reason,
      });
    } catch {
      /* fail-open: in-memory set holds it for this revision; re-run /admin/revoke to persist durably */
    }
  }
  return { ...latest };
}

/** Hot-path revocation check. Sync + IO-free (in-memory Set), safe to run on every request. */
export function isRevoked(rawToken: string): boolean {
  if (revokedHashes.size === 0) return false;
  return revokedHashes.has(hashToken(rawToken));
}

export function getRevocationState(): RevocationState {
  return { ...latest };
}

/** Clear ALL revocations (ops reset via /admin/clear-revoke, and test teardown). Best-effort deletes the
 *  durable Cosmos docs too so a cleared token stays cleared across a redeploy. */
export async function clearRevocation(): Promise<void> {
  const hashes = [...revokedHashes];
  revokedHashes.clear();
  latest = { revoked_token_hash: null, revoked_at: null, revoked_reason: null };
  if (cosmosConfigured()) {
    for (const h of hashes) {
      try {
        await deleteDoc(CACHE_COLL, idFor(h), idFor(h));
      } catch {
        /* best-effort */
      }
    }
  }
}

// ── Multi-replica propagation ──────────────────────────────────────────────────────────────────────
// The gateway runs behind Front Door / APIM and can serve from MORE THAN ONE replica. A /admin/revoke
// lands on exactly ONE replica: it updates that replica's in-memory set + Cosmos, but the OTHER replicas
// keep their stale set until they reboot. Verified live 2026-07-16: right after a single revoke, the
// leaked token was still HTTP 200 on ~half of requests. So each replica periodically re-pulls the durable
// blocklist from Cosmos, making any revoke fleet-wide within one interval with NO restart and no manual
// fan-out. loadRevocations() is add-only (never un-revokes on a transient empty read -> fail-SAFE for a
// kill-switch); a genuine clear is handled per-replica + the Cosmos delete, and a lagging replica that
// keeps a cleared token rejected for one extra interval is the safe direction to err. Cheap: one tiny
// kind-filtered query on a handful of docs.
const RELOAD_MS = Number(process.env.REVOCATION_RELOAD_MS) || 30_000;
let _reloadTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic Cosmos reconciler (idempotent; no-op without Cosmos). Called once from server boot. */
export function startRevocationReloader(): void {
  if (_reloadTimer || !cosmosConfigured()) return;
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
