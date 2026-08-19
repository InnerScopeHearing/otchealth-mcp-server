/**
 * Hyperagent OAuth token store: durable, multi-replica-safe refresh-token rotation.
 *
 * WHY THIS EXISTS. Hyperagent's refresh tokens are SINGLE-USE — verified live on 2026-08-18, where
 * one refresh returned a different refresh_token — and its access tokens live only ~15 minutes. The
 * gateway runs 2+ replicas, so each replica refreshes roughly four times an hour. Holding the
 * rotated token in memory (the original implementation) fails in two ways that both end with the
 * human being sent back to the browser:
 *
 *   1. Replica A rotates; replica B is still holding the token A just consumed.
 *   2. Any redeploy drops both replicas back to the configured bootstrap value, which is spent.
 *
 * And the downside is not a retry. Under RFC 9700 refresh-token reuse detection, presenting a
 * consumed token can revoke the ENTIRE token family, which costs a fresh human consent. So the
 * token must be persisted durably, shared across replicas, and rotated under a lock.
 *
 * THIS IS DELIBERATELY THE SAME SHAPE AS src/tools/xero/client.ts. Xero's refresh tokens are
 * single-use for the same reason and that implementation has already been through the incidents
 * this one has not. Mirroring it — in-process mutex, ETag'd persist, persist-before-use,
 * adopt-the-winner on a lost race, family-hashed bootstrap, ETag'd dead-mark — means a fix or a
 * lesson learned on either side reads across to the other. A second, subtly different rotation
 * implementation would be strictly worse than a familiar one.
 */

import crypto from 'node:crypto';

// Via the DISPATCHER (store.js), never a concrete backend. Importing postgres.js directly would
// pin this to one store regardless of STATE_BACKEND, and the agentstate dependency guard fails the
// build for exactly that reason: on a cutover the bypass is silent, because the write succeeds
// against the wrong store. Caught here by that guard, which is what it is for.
import { createDoc, isConfigured, readDoc, replaceDoc } from '../../agentstate/store.js';
import { loadEnv } from '../../config/env.js';

const TOKEN_ENDPOINT = 'https://hyperagent.com/api/oauth/token';
const CACHE_COLL = 'cache';
const DOC_ID = 'hyperagent-oauth-token';

/** A hung refresh must never wedge a replica. */
const FETCH_TIMEOUT_MS = 15_000;
/** Refresh early so a token cannot expire between the check and the call it authorizes. */
const EXPIRY_SKEW_MS = 60_000;

export interface HyperagentTokenDoc extends Record<string, unknown> {
  id: string;
  kind: 'hyperagent-oauth';
  status: 'live' | 'dead';
  /** Hash of the CONFIGURED bootstrap token, so a fresh consent supersedes the stored chain. */
  bootstrapHash: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  deadReason?: string;
  updatedAt: string;
}

export interface TokenDeps {
  fetchImpl: typeof fetch;
  read: typeof readDoc;
  replace: typeof replaceDoc;
  create: typeof createDoc;
  stateConfigured: typeof isConfigured;
}
const defaultDeps: TokenDeps = {
  fetchImpl: fetch,
  read: readDoc,
  replace: replaceDoc,
  create: createDoc,
  stateConfigured: isConfigured,
};

/** Identifies WHICH consent a stored chain descends from. Never the token itself. */
export function bootstrapHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/** In-process mutex: serializes refreshes WITHIN a replica. ETags cover across replicas. */
let lock: Promise<unknown> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  lock = prev.then(() => gate);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

export class HyperagentNeedsConsentError extends Error {
  constructor(detail: string) {
    super(
      `Hyperagent needs re-consent: its refresh-token chain is dead (${detail}). ` +
        `Human step: complete the Hyperagent OAuth consent once in a browser and store the new ` +
        `refresh token as the hyperagent-refresh-token secret. The gateway re-bootstraps ` +
        `automatically from it (bootstrapHash), no code change or redeploy needed.`,
    );
    this.name = 'HyperagentNeedsConsentError';
  }
}

function buildDoc(input: {
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  bootstrapHash: string;
}): HyperagentTokenDoc {
  return {
    id: DOC_ID,
    kind: 'hyperagent-oauth',
    status: 'live',
    bootstrapHash: input.bootstrapHash,
    refreshToken: input.refreshToken,
    accessToken: input.accessToken,
    expiresAt: Date.now() + input.expiresInSeconds * 1000,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshGrant(
  deps: TokenDeps,
  clientId: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | 'invalid_grant'> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  // Hyperagent registered this as a PUBLIC client (its metadata advertises
  // token_endpoint_auth_methods_supported: ["none"]), so there is normally no secret. Send one only
  // if an operator has configured a confidential client.
  const secret = loadEnv().HYPERAGENT_CLIENT_SECRET;
  if (secret) body.set('client_secret', secret);

  const r = await deps.fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) {
    if (r.status === 400 && /invalid_grant/i.test(text)) return 'invalid_grant';
    // Status only. A token endpoint's error body can echo the submitted credential.
    throw new Error(`Hyperagent token refresh failed: HTTP ${r.status}`);
  }
  const j = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('Hyperagent token refresh returned no access_token');
  // Rotation is the observed behaviour, but do not REQUIRE a new refresh token: if the provider ever
  // stops rotating, reusing the current one is correct, and demanding rotation would break the
  // broker on a vendor change that is otherwise harmless.
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || refreshToken,
    expiresIn: j.expires_in ?? 900,
  };
}

/**
 * If the store now holds a LIVE doc from the SAME consent family with a still-valid access token,
 * return it. This is how a replica that lost a write race adopts the WINNER's chain rather than
 * clobbering it or persisting a fork.
 */
async function adoptWinner(deps: TokenDeps, bHash: string): Promise<string | null> {
  const w = await deps.read(CACHE_COLL, DOC_ID, DOC_ID);
  const doc = w?.doc as HyperagentTokenDoc | undefined;
  if (doc && doc.status === 'live' && doc.bootstrapHash === bHash && doc.accessToken && doc.expiresAt > Date.now()) {
    return doc.accessToken;
  }
  return null;
}

export function hyperagentConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.HYPERAGENT_CLIENT_ID && env.HYPERAGENT_REFRESH_TOKEN);
}

/**
 * Get a live Hyperagent access token, refreshing and PERSISTING FIRST when needed.
 *
 * Multi-replica safe: every persist is an ETag'd REPLACE (or a first-use CREATE); a 412 loser adopts
 * the winner's chain and never persists its fork.
 */
export async function getAccessToken(opts: { deps?: TokenDeps } = {}): Promise<string | null> {
  const deps = opts.deps ?? defaultDeps;
  const env = loadEnv();
  const clientId = env.HYPERAGENT_CLIENT_ID;
  const bootstrap = env.HYPERAGENT_REFRESH_TOKEN;
  if (!clientId || !bootstrap) return null;

  // FAIL CLOSED, deliberately. Without the shared store there is no cross-replica serialization, and
  // an unsynchronized rotation is exactly what can burn the whole token family and cost a human
  // consent. A temporary outage of the hyperagent tools is a far cheaper failure than that, so this
  // refuses rather than falling back to the in-memory behaviour this module exists to replace.
  if (!deps.stateConfigured()) {
    throw new Error(
      'Hyperagent broker disabled: the shared agent-state store is not configured (PG_HOST unset). ' +
        'Refresh tokens are single-use, so rotating them without cross-replica serialization risks ' +
        'revoking the token family and forcing a new human consent.',
    );
  }

  const bHash = bootstrapHash(bootstrap);

  return withLock(async () => {
    const existing = await deps.read(CACHE_COLL, DOC_ID, DOC_ID);
    const doc = existing?.doc as HyperagentTokenDoc | undefined;
    // KEEP the etag even on re-consent: the old doc is REPLACED, never created over.
    const etag = existing?.etag ?? null;
    const sameFamily = Boolean(doc && doc.bootstrapHash === bHash);

    // A dead-mark only blocks within the SAME consent family. A dead doc from an older family is the
    // documented recovery path: storing a fresh refresh token supersedes it below.
    if (doc?.status === 'dead' && sameFamily) throw new HyperagentNeedsConsentError(doc.deadReason || 'marked dead');

    // Still-valid cached access token from this family: no refresh, no rotation, no risk.
    if (sameFamily && doc?.status === 'live' && doc.accessToken && doc.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return doc.accessToken;
    }

    // Refresh from the stored chain when it is the same live family; otherwise from the configured
    // bootstrap (first use OR a fresh consent).
    const chainToken = sameFamily && doc?.refreshToken ? doc.refreshToken : bootstrap;
    const grant = await refreshGrant(deps, clientId, chainToken);

    if (grant === 'invalid_grant') {
      // Never clobber a live winner: a concurrent replica may have just rotated successfully.
      const winner = await adoptWinner(deps, bHash);
      if (winner) return winner;

      const dead = buildDoc({ refreshToken: '', accessToken: '', expiresInSeconds: 0, bootstrapHash: bHash });
      dead.status = 'dead';
      // REPORT THE VENDOR'S ERROR, NOT A GUESS ABOUT ITS CAUSE. `invalid_grant` covers rotation
      // consumption, idle expiry, revocation and app-standing changes alike; naming one manufactures
      // a false lead for whoever reads this during an incident, and a false lead costs more than
      // none. The remediation is identical either way.
      dead.deadReason = 'invalid_grant (as returned by Hyperagent; cause not determinable from this code)';
      try {
        if (etag) {
          const res = await deps.replace(CACHE_COLL, DOC_ID, DOC_ID, dead, etag);
          if (res.status === 412) {
            const w = await adoptWinner(deps, bHash);
            if (w) return w; // a concurrent live chain won the race, use it rather than dead-marking
          }
        } else {
          await deps.create(CACHE_COLL, DOC_ID, dead);
        }
      } catch {
        const w = await adoptWinner(deps, bHash);
        if (w) return w; // create 409 raced with a live winner
      }
      throw new HyperagentNeedsConsentError('invalid_grant from hyperagent.com');
    }

    const next = buildDoc({
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      expiresInSeconds: grant.expiresIn,
      bootstrapHash: bHash,
    });

    // PERSIST BEFORE USE. Returning an unpersisted rotation would mean the NEXT caller presents a
    // token this one already consumed, which is the reuse that gets a family revoked.
    if (etag) {
      const res = await deps.replace(CACHE_COLL, DOC_ID, DOC_ID, next, etag);
      if (res.status === 412) {
        const winner = await adoptWinner(deps, bHash);
        if (winner) return winner;
        // Residual-race repair: the racer may have written a same-family DEAD tombstone just before
        // us. A tombstone holds no token material and we hold a freshly VALIDATED grant, so revive
        // it rather than discard a good rotation and force a needless consent. Bounded to one try.
        const cur = await deps.read(CACHE_COLL, DOC_ID, DOC_ID);
        const cdoc = cur?.doc as HyperagentTokenDoc | undefined;
        if (cur?.etag && cdoc?.status === 'dead' && cdoc.bootstrapHash === bHash) {
          const revived = await deps.replace(CACHE_COLL, DOC_ID, DOC_ID, next, cur.etag);
          if (revived.ok) return next.accessToken;
          const w2 = await adoptWinner(deps, bHash);
          if (w2) return w2;
        }
        throw new Error('Hyperagent: lost a rotation race and the winner chain is unusable; retry');
      }
      if (!res.ok) {
        throw new Error(`Hyperagent: token persist failed (${res.status}); NOT returning an unpersisted chain`);
      }
    } else {
      try {
        await deps.create(CACHE_COLL, DOC_ID, next);
      } catch {
        const winner = await adoptWinner(deps, bHash);
        if (winner) return winner;
        throw new Error('Hyperagent: token persist failed on create; NOT returning an unpersisted chain');
      }
    }

    return next.accessToken;
  });
}

/** Test seam: drop the in-process lock chain. Never called in production paths. */
export function __resetHyperagentTokenLockForTests(): void {
  lock = Promise.resolve();
}
