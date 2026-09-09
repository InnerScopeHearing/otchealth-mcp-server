/**
 * Durable ownership BEFORE submitting Hyperagent's single-use refresh token.
 * A CAS after the token endpoint is too late: two replicas can already have consumed the
 * same token. Claim the shared document first, then persist the rotated chain before use.
 * An abandoned/uncertain claim is never taken over: the provider may have consumed its token.
 */
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDoc, isConfigured, readDoc, replaceDoc } from '../../agentstate/store.js';
import { loadEnv } from '../../config/env.js';

const TOKEN_ENDPOINT = 'https://hyperagent.com/api/oauth/token';
const CACHE_COLL = 'cache';
const DOC_ID = 'hyperagent-oauth-token';
const FETCH_TIMEOUT_MS = 15_000;
const EXPIRY_SKEW_MS = 60_000;
const CLAIM_STALE_MS = 45_000;
const WAIT_ATTEMPTS = 200;
const WAIT_MS = 100;
const WAIT_DEADLINE_MS = 20_000;
const STORE_TIMEOUT_MS = 5_000;

export interface HyperagentTokenDoc extends Record<string, unknown> {
  id: string;
  kind: 'hyperagent-oauth';
  status: 'live' | 'dead';
  bootstrapHash: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  deadReason?: string;
  updatedAt: string;
  /** A dead, token-free document is also fail-closed for older gateway replicas. */
  rotationClaim?: { id: string; startedAt: number };
}

export interface TokenDeps {
  fetchImpl: typeof fetch;
  read: typeof readDoc;
  replace: typeof replaceDoc;
  create: typeof createDoc;
  stateConfigured: typeof isConfigured;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
const defaultDeps: TokenDeps = {
  fetchImpl: fetch, read: readDoc, replace: replaceDoc, create: createDoc,
  stateConfigured: isConfigured,
};

export function bootstrapHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export class HyperagentNeedsConsentError extends Error {
  constructor(detail: string) {
    super(`Hyperagent needs re-consent: its refresh-token chain is unusable (${detail}). ` +
      'Human step: complete Hyperagent OAuth consent once and store the new refresh token as the ' +
      'hyperagent-refresh-token secret. Do not replay a possibly consumed refresh token.');
    this.name = 'HyperagentNeedsConsentError';
  }
}

export class HyperagentRefreshPendingError extends Error {
  constructor() {
    super('Hyperagent refresh is owned by another request; retry the read after it finishes.');
    this.name = 'HyperagentRefreshPendingError';
  }
}

function usable(doc: HyperagentTokenDoc | undefined, family: string, now: number, rejected?: string): boolean {
  return Boolean(doc?.status === 'live' && !doc.rotationClaim && doc.bootstrapHash === family &&
    doc.accessToken && doc.accessToken !== rejected && doc.expiresAt - EXPIRY_SKEW_MS > now);
}

/** A timed-out store mutation may still commit, so callers must treat it as uncertain. */
async function boundedStore<T>(operation: Promise<T>, timeoutMs = STORE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('TOKEN_STORE_TIMEOUT')), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

async function refreshGrant(deps: TokenDeps, clientId: string, refreshToken: string): Promise<{
  accessToken: string; refreshToken: string; expiresIn: number;
} | 'invalid_grant'> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  const secret = loadEnv().HYPERAGENT_CLIENT_SECRET;
  if (secret) body.set('client_secret', secret);
  const response = await deps.fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 400 && /invalid_grant/i.test(text)) return 'invalid_grant';
    throw new Error('REFRESH_OUTCOME_UNCERTAIN');
  }
  const data = JSON.parse(text) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  // Missing or unchanged replacement material must not persist the submitted single-use token.
  if (typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token === refreshToken ||
      (data.expires_in !== undefined && (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 60))) {
    throw new Error('REFRESH_OUTCOME_UNCERTAIN');
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: (data.expires_in as number | undefined) ?? 900 };
}

export function hyperagentConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.HYPERAGENT_CLIENT_ID && env.HYPERAGENT_REFRESH_TOKEN);
}

/**
 * rejectedAccessToken refreshes ONLY if the shared chain still contains that exact token.
 * A different valid token means another replica repaired the rejection; adopt it instead.
 * The shared CAS is the only lock, so independent processes follow the same tested path.
 */
export async function getAccessToken(opts: { deps?: TokenDeps; rejectedAccessToken?: string } = {}): Promise<string | null> {
  const deps = opts.deps ?? defaultDeps;
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? (async (ms: number) => { await delay(ms); });
  const env = loadEnv();
  const clientId = env.HYPERAGENT_CLIENT_ID;
  const bootstrap = env.HYPERAGENT_REFRESH_TOKEN;
  if (!clientId || !bootstrap) return null;
  if (!deps.stateConfigured()) throw new Error('Hyperagent broker disabled: the shared agent-state store is not configured; refusing unsynchronized refresh.');
  const family = bootstrapHash(bootstrap);
  const waitingDeadline = now() + WAIT_DEADLINE_MS;

  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (now() >= waitingDeadline) throw new HyperagentRefreshPendingError();
    let existing: Awaited<ReturnType<TokenDeps['read']>>;
    try { existing = await boundedStore(deps.read(CACHE_COLL, DOC_ID, DOC_ID), Math.min(STORE_TIMEOUT_MS, waitingDeadline - now())); }
    catch { throw new Error('Hyperagent shared token state unavailable; no refresh attempted.'); }
    if (now() >= waitingDeadline) throw new HyperagentRefreshPendingError();
    const doc = existing?.doc as HyperagentTokenDoc | undefined;
    const sameFamily = doc?.bootstrapHash === family;

    if (sameFamily && doc.rotationClaim) {
      const claim = doc.rotationClaim;
      if (!claim.id || !Number.isFinite(claim.startedAt) || now() - claim.startedAt >= CLAIM_STALE_MS) {
        throw new HyperagentNeedsConsentError('a previous refresh outcome is unknown');
      }
      await wait(Math.min(WAIT_MS, waitingDeadline - now()));
      continue;
    }
    if (sameFamily && doc.status === 'dead') throw new HyperagentNeedsConsentError('stored chain is marked dead');
    if (doc && usable(doc, family, now(), opts.rejectedAccessToken)) return doc.accessToken;
    if (existing && !existing.etag) throw new Error('Hyperagent token state has no ETag; no refresh attempted.');
    const chainToken = sameFamily && doc?.refreshToken ? doc.refreshToken : bootstrap;
    if (sameFamily && !doc?.refreshToken) throw new HyperagentNeedsConsentError('stored chain has no refresh token');
    const claim: HyperagentTokenDoc = {
      id: DOC_ID, kind: 'hyperagent-oauth', status: 'dead', bootstrapHash: family,
      refreshToken: '', accessToken: '', expiresAt: 0, updatedAt: new Date(now()).toISOString(),
      deadReason: 'refresh in progress or outcome unknown',
      rotationClaim: { id: crypto.randomUUID(), startedAt: now() },
    };
    let claimed: Awaited<ReturnType<TokenDeps['replace']>>;
    try {
      claimed = await boundedStore(existing
        ? deps.replace(CACHE_COLL, DOC_ID, DOC_ID, claim, existing.etag!)
        : deps.create(CACHE_COLL, DOC_ID, claim), Math.min(STORE_TIMEOUT_MS, waitingDeadline - now()));
    } catch {
      // Ambiguous claim writes may have committed. Never submit from an unconfirmed claim.
      // A first-create conflict may re-read another owner's claim, never adopt our own.
      if (!existing) {
        let winner: Awaited<ReturnType<TokenDeps['read']>>;
        try { winner = await boundedStore(deps.read(CACHE_COLL, DOC_ID, DOC_ID), Math.max(1, Math.min(STORE_TIMEOUT_MS, waitingDeadline - now()))); } catch { winner = null; }
        const winnerDoc = winner?.doc as HyperagentTokenDoc | undefined;
        if (winnerDoc && winnerDoc.rotationClaim?.id !== claim.rotationClaim!.id) continue;
      }
      throw new Error('Hyperagent refresh claim outcome unknown; no token endpoint request attempted.');
    }
    if (claimed.status === 412 || claimed.status === 409) continue;
    if (!claimed.ok || !claimed.etag) throw new Error('Hyperagent refresh claim not confirmed; no token endpoint request attempted.');

    let grant: Awaited<ReturnType<typeof refreshGrant>>;
    try { grant = await refreshGrant(deps, clientId, chainToken); }
    catch {
      // Retain the token-free claim: timeout, lost response or malformed success may have
      // consumed the token. Releasing this claim would allow unsafe reuse.
      throw new HyperagentNeedsConsentError('the token endpoint outcome is unknown');
    }
    const next: HyperagentTokenDoc = grant === 'invalid_grant'
      ? { ...claim, rotationClaim: undefined, deadReason: 'invalid_grant returned by Hyperagent' }
      : {
        id: DOC_ID, kind: 'hyperagent-oauth', status: 'live', bootstrapHash: family,
        accessToken: grant.accessToken, refreshToken: grant.refreshToken,
        expiresAt: now() + grant.expiresIn * 1000, updatedAt: new Date(now()).toISOString(),
      };
    let persisted: Awaited<ReturnType<TokenDeps['replace']>>;
    try { persisted = await boundedStore(deps.replace(CACHE_COLL, DOC_ID, DOC_ID, next, claimed.etag)); }
    catch { throw new Error('Hyperagent token persist outcome unknown; NOT returning an unpersisted chain.'); }
    if (!persisted.ok) {
      // Only an already-persisted valid winner may be used. Never revive a tombstone or replay.
      if (persisted.status === 412) {
        let winner: Awaited<ReturnType<TokenDeps['read']>>;
        try { winner = await boundedStore(deps.read(CACHE_COLL, DOC_ID, DOC_ID)); } catch { winner = null; }
        const winnerDoc = winner?.doc as HyperagentTokenDoc | undefined;
        if (winnerDoc && winnerDoc.accessToken !== doc?.accessToken &&
            usable(winnerDoc, family, now(), opts.rejectedAccessToken)) return winnerDoc.accessToken;
      }
      throw new Error('Hyperagent token persist failed; NOT returning an unpersisted chain.');
    }
    if (grant === 'invalid_grant') throw new HyperagentNeedsConsentError('invalid_grant returned by Hyperagent');
    return next.accessToken;
  }
  throw new HyperagentRefreshPendingError();
}

/** Compatibility seam for callers' existing test setup. There is no process-local lock now. */
export function __resetHyperagentTokenLockForTests(): void {}
