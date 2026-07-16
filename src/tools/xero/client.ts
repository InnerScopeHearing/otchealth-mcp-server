/**
 * XERO (accounting of record) — read-only gateway service for the executive ring.
 *
 * WHY THIS EXISTS (Matt directive 2026-07-16, "permanent fix for Xero"): the CFO seat moved to
 * Claude Chat, which has no filesystem/CLI — the old skills/xero/xero.mjs path (Claude Code) and
 * the Hyperagent Xero skill are unreachable from there. This module makes Xero a first-class
 * gateway service so ANY engine holding an exec-ring lane can read the books. QuickBooks is
 * RETIRED (operator directive 2026-07-16): Xero is the sole accounting integration; QBO history
 * lives in the finance data room as static exports.
 *
 * ===================== THE ONE HARD PROBLEM: ROTATE-ON-USE REFRESH TOKENS =====================
 * Xero refresh tokens are SINGLE-USE: every refresh returns a NEW refresh token and retires the
 * old one (a superseded token gets a short grace window, then dies). Two consequences:
 *   1. The new refresh token MUST be durably persisted BEFORE the access token is used — losing
 *      it means the org's chain is lost and a human must re-consent (the exact INND lockout of
 *      2026-06-20).
 *   2. The gateway runs 2-10 REPLICAS. Two replicas refreshing the same org concurrently would
 *      fork the chain. We serialize via Cosmos optimistic concurrency (ETag): the loser of a
 *      write race DISCARDS its fork and adopts the winner's tokens.
 * The durable chain lives in the Cosmos `cache` container with per-item `ttl: -1` — the container
 * has a 7-day default TTL for real cache entries, and -1 disables expiry for THIS doc. That ttl
 * field is LOAD-BEARING (an expiring token doc = a lost chain = human re-consent); it is pinned
 * by a test. Bootstrap: the very first use of an org (or a changed secret, detected via
 * bootstrapHash) starts the chain from the XERO_RT_<ORG> container secret, seeded once from the
 * fleet secret store. After bootstrap, Cosmos is canonical and the env secret is ignored.
 *
 * ===================== RING (unwaivable) =====================
 * Books are MNPI/financial. Every tool here is gated to the EXECUTIVE RING — the same
 * single-source-of-truth ring kb_search_privileged enforces on the finance rooms (EXEC_RING,
 * kb/search-privileged.ts). cto/default/developer/app-leads/external are refused in the handler.
 * READ-ONLY by design: no tool here can post, so financial WRITES stay Matt-gated by construction.
 * Token values never appear in tool output, summaries, or logs.
 */
import { createHash } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { EXEC_RING } from '../kb/search-privileged.js';
import {
  isConfigured as cosmosConfigured,
  readDoc,
  replaceDoc,
  createDoc,
} from '../../agentstate/cosmos.js';

/** Bounded network deadline for every Xero call — a hung refresh must never wedge a replica. */
const FETCH_TIMEOUT_MS = 15000;

export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

/** The four orgs of record. Env slots follow XERO_RT_<KEY> / XERO_TENANT_<KEY>. */
export const XERO_ORGS = ['otchealth', 'innd', 'hearingassist', 'personal'] as const;
export type XeroOrg = (typeof XERO_ORGS)[number];

/** Fallback tenant-name heuristics when no XERO_TENANT_<ORG> pin is set. */
const TENANT_NAME_HINTS: Record<XeroOrg, RegExp> = {
  otchealth: /otc\s*health/i,
  innd: /inner\s*scope|innd/i,
  hearingassist: /hearing\s*assist/i,
  personal: /matthew|moore|personal/i,
};

/** Ring predicate — EXEC_RING only, same source of truth as the finance rooms. Pure. */
export function isXeroAllowed(caller: string | undefined | null): boolean {
  return Boolean(caller) && (EXEC_RING as readonly string[]).includes(caller as string);
}

/** Cosmos doc id/pk for an org's token chain. Dots, not colons (Cosmos id charset). Pure. */
export function tokenDocId(org: XeroOrg): string {
  return `svc-token.xero.${org}`;
}

/** Hash of the bootstrap secret — detects an operator re-consent (new secret => new chain). Pure. */
export function bootstrapHash(envRefreshToken: string): string {
  return createHash('sha256').update(envRefreshToken || '').digest('hex').slice(0, 32);
}

export interface XeroTokenDoc extends Record<string, unknown> {
  id: string;
  /** LOAD-BEARING: the `cache` container partitions on /cacheScope (NOT /id). Cosmos extracts the
   * partition key from THIS field of the body; it must equal the pk we pass (= tokenDocId(org)) or
   * every create/replace/upsert returns 400. Matches the repo convention (result-store.ts cacheScope=id). */
  cacheScope: string;
  /** LOAD-BEARING: -1 disables the cache container's 7-day default TTL for this doc. */
  ttl: number;
  org: XeroOrg;
  status: 'live' | 'dead';
  refreshToken: string;
  accessToken: string;
  /** epoch ms when accessToken stops being trustworthy (already margin-adjusted). */
  expiresAt: number;
  tenantId: string;
  tenantName: string;
  bootstrapHash: string;
  rotatedAt: string;
  deadReason?: string;
}

/** Build the persisted token doc. Pure; pinned by tests (especially ttl:-1). */
export function buildTokenDoc(input: {
  org: XeroOrg;
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
  tenantId: string;
  tenantName: string;
  bootstrapHash: string;
}): XeroTokenDoc {
  return {
    id: tokenDocId(input.org),
    cacheScope: tokenDocId(input.org), // partition key of the `cache` container (see interface note)
    ttl: -1,
    org: input.org,
    status: 'live',
    refreshToken: input.refreshToken,
    accessToken: input.accessToken,
    // 90s safety margin so a token is never used within its final seconds mid-request.
    expiresAt: Date.now() + Math.max(0, input.expiresInSeconds - 90) * 1000,
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    bootstrapHash: input.bootstrapHash,
    rotatedAt: new Date().toISOString(),
  };
}

/** Env accessors for an org's bootstrap secret + optional tenant pin. */
function envBootstrapToken(env: Record<string, unknown>, org: XeroOrg): string {
  return String(env[`XERO_RT_${org.toUpperCase()}` as keyof typeof env] || '');
}
function envTenantPin(env: Record<string, unknown>, org: XeroOrg): string {
  return String(env[`XERO_TENANT_${org.toUpperCase()}` as keyof typeof env] || '');
}

export function xeroConfigured(): boolean {
  const env = loadEnv() as unknown as Record<string, unknown>;
  const anyRt = XERO_ORGS.some((o) => envBootstrapToken(env, o));
  return Boolean(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET && anyRt && cosmosConfigured());
}

/** Which orgs have a bootstrap secret configured (status surface for xero_orgs). */
export function configuredOrgs(): XeroOrg[] {
  const env = loadEnv() as unknown as Record<string, unknown>;
  return XERO_ORGS.filter((o) => envBootstrapToken(env, o));
}

// ---------------------------------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------------------------------

/** Injectable seams so the rotation logic is unit-testable without Cosmos or Xero. */
export interface TokenDeps {
  fetchImpl: typeof fetch;
  read: typeof readDoc;
  replace: typeof replaceDoc;
  create: typeof createDoc;
}
const defaultDeps: TokenDeps = { fetchImpl: fetch, read: readDoc, replace: replaceDoc, create: createDoc };

const CACHE_COLL = 'cache';

/** In-process per-org mutex: serializes refreshes WITHIN a replica (ETag covers across replicas). */
const orgLocks = new Map<string, Promise<unknown>>();
async function withOrgLock<T>(org: string, fn: () => Promise<T>): Promise<T> {
  const prev = orgLocks.get(org) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  orgLocks.set(org, prev.then(() => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

class XeroDeadOrgError extends Error {
  constructor(org: XeroOrg, detail: string) {
    super(
      `Xero org "${org}" needs re-consent: its refresh-token chain is dead (${detail}). ` +
        `Human step: run the Xero OAuth consent for this org, store the new refresh token as the ` +
        `XERO_RT_${org.toUpperCase()} gateway secret — the gateway re-bootstraps automatically (bootstrapHash).`,
    );
    this.name = 'XeroDeadOrgError';
  }
}

async function refreshGrant(
  deps: TokenDeps,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | 'invalid_grant'> {
  const r = await deps.fetchImpl(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await r.text();
  if (!r.ok) {
    if (r.status === 400 && /invalid_grant/i.test(body)) return 'invalid_grant';
    throw new Error(`Xero token refresh failed: HTTP ${r.status} ${body.slice(0, 160)}`);
  }
  const j = JSON.parse(body) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token || !j.refresh_token) throw new Error('Xero token refresh returned no tokens');
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in ?? 1800 };
}

async function resolveTenant(
  deps: TokenDeps,
  accessToken: string,
  org: XeroOrg,
  pin: string,
): Promise<{ tenantId: string; tenantName: string }> {
  const r = await deps.fetchImpl(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Xero /connections failed: HTTP ${r.status}`);
  const conns = (await r.json()) as Array<{ tenantId: string; tenantName?: string }>;
  if (!conns.length) throw new Error(`Xero org "${org}": token has no connected tenants`);
  const byPin = pin ? conns.find((c) => c.tenantId === pin) : undefined;
  const byName = conns.find((c) => TENANT_NAME_HINTS[org].test(c.tenantName || ''));
  const hit = byPin || byName || (conns.length === 1 ? conns[0] : undefined);
  if (!hit) {
    const names = conns.map((c) => c.tenantName || '(unnamed)').join(', ');
    throw new Error(
      `Xero org "${org}": cannot pick a tenant among [${names}]. Set the XERO_TENANT_${org.toUpperCase()} env to the tenantId.`,
    );
  }
  return { tenantId: hit.tenantId, tenantName: hit.tenantName || '' };
}

type OrgAccess = { accessToken: string; tenantId: string; tenantName: string };

/**
 * If Cosmos now holds a LIVE doc for this org from the SAME consent family (bootstrapHash) with a
 * still-valid access token, return it. This is how a replica that LOST a write race (or that just
 * hit invalid_grant on a superseded token) adopts the WINNER's chain instead of clobbering it or
 * persisting a fork. Family-matching is essential: never adopt a superseded (old-secret) chain.
 */
async function adoptWinner(deps: TokenDeps, id: string, bHash: string): Promise<OrgAccess | null> {
  const w = await deps.read(CACHE_COLL, id, id);
  const wdoc = w?.doc as XeroTokenDoc | undefined;
  if (
    wdoc &&
    wdoc.status === 'live' &&
    wdoc.bootstrapHash === bHash &&
    wdoc.accessToken &&
    wdoc.expiresAt > Date.now() &&
    wdoc.tenantId
  ) {
    return { accessToken: wdoc.accessToken, tenantId: wdoc.tenantId, tenantName: wdoc.tenantName };
  }
  return null;
}

/**
 * Get a live access token + tenant for an org. Refreshes (and PERSISTS FIRST) when needed.
 * Multi-replica safe: every persist is an ETag'd REPLACE (or a first-use CREATE); a 412/409 loser
 * adopts the winner's chain and NEVER persists its fork. Operator re-consent (a changed bootstrap
 * secret) supersedes the stored doc via REPLACE (not create), and the dead-mark on invalid_grant is
 * itself ETag'd so it can never overwrite a concurrent replica's freshly-rotated live chain.
 */
export async function getOrgAccess(org: XeroOrg, opts: { forceRefresh?: boolean; deps?: TokenDeps } = {}): Promise<OrgAccess> {
  const deps = opts.deps ?? defaultDeps;
  const env = loadEnv() as unknown as Record<string, unknown>;
  const clientId = String(env.XERO_CLIENT_ID || '');
  const clientSecret = String(env.XERO_CLIENT_SECRET || '');
  if (!clientId || !clientSecret) throw new Error('Xero not configured (XERO_CLIENT_ID/SECRET missing)');
  const bootstrap = envBootstrapToken(env, org);
  if (!bootstrap) throw new Error(`Xero org "${org}" not configured (XERO_RT_${org.toUpperCase()} missing)`);
  const bHash = bootstrapHash(bootstrap);
  const pin = envTenantPin(env, org);
  const id = tokenDocId(org);

  return withOrgLock(org, async () => {
    const existing = await deps.read(CACHE_COLL, id, id);
    const doc = existing?.doc as XeroTokenDoc | undefined;
    const etag = existing?.etag ?? null; // KEEP this even on re-consent — we REPLACE the old doc, never create over it.
    const sameFamily = Boolean(doc && doc.bootstrapHash === bHash);
    // reconsent: a doc exists but from an OLDER bootstrap secret. It is superseded via the replace below.

    // A dead-mark only blocks when it is the SAME consent family. A dead doc from an OLDER family is
    // the documented recovery trigger — the re-consent (fresh XERO_RT_<ORG>) supersedes it below.
    if (doc?.status === 'dead' && sameFamily) throw new XeroDeadOrgError(org, doc.deadReason || 'marked dead');

    // Fresh cached access token from THIS family: no refresh, no rotation.
    if (!opts.forceRefresh && sameFamily && doc?.status === 'live' && doc.accessToken && doc.expiresAt > Date.now() && doc.tenantId) {
      return { accessToken: doc.accessToken, tenantId: doc.tenantId, tenantName: doc.tenantName };
    }

    // Refresh from the stored chain when it is the same live family; otherwise from the env bootstrap
    // secret (first use OR operator re-consent). On re-consent we still hold `etag`, so we REPLACE.
    const chainToken = sameFamily && doc?.refreshToken ? doc.refreshToken : bootstrap;
    const grant = await refreshGrant(deps, clientId, clientSecret, chainToken);

    if (grant === 'invalid_grant') {
      // Never clobber a live winner: if a concurrent replica just rotated a live chain, adopt it.
      const winner = await adoptWinner(deps, id, bHash);
      if (winner) return winner;
      // ETag'd dead-mark (B3): a plain upsert here could overwrite another replica's fresh live chain.
      const dead = buildTokenDoc({
        org,
        refreshToken: '',
        accessToken: '',
        expiresInSeconds: 0,
        tenantId: doc?.tenantId || '',
        tenantName: doc?.tenantName || '',
        bootstrapHash: bHash,
      });
      dead.status = 'dead';
      dead.deadReason = `invalid_grant (chain consumed elsewhere or expired)`;
      try {
        if (etag) {
          const res = await deps.replace(CACHE_COLL, id, id, dead, etag);
          if (res.status === 412) {
            const w = await adoptWinner(deps, id, bHash);
            if (w) return w; // a concurrent live chain won the race — use it, don't dead-mark
          }
        } else {
          await deps.create(CACHE_COLL, id, dead);
        }
      } catch {
        const w = await adoptWinner(deps, id, bHash);
        if (w) return w; // create 409 raced with a live winner
      }
      throw new XeroDeadOrgError(org, 'invalid_grant from identity.xero.com');
    }

    // Resolve the tenant (reuse the stored one only within the same family; re-consent re-resolves).
    const tenant = sameFamily && doc?.tenantId
      ? { tenantId: doc.tenantId, tenantName: doc.tenantName }
      : await resolveTenant(deps, grant.accessToken, org, pin);

    const next = buildTokenDoc({
      org,
      refreshToken: grant.refreshToken,
      accessToken: grant.accessToken,
      expiresInSeconds: grant.expiresIn,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      bootstrapHash: bHash,
    });

    // PERSIST BEFORE USE. REPLACE when a doc exists (normal rotation OR re-consent supersede); CREATE
    // only on true first use. A race resolves by adopting the winner (same family), never a fork.
    if (etag) {
      const res = await deps.replace(CACHE_COLL, id, id, next, etag);
      if (res.status === 412) {
        const winner = await adoptWinner(deps, id, bHash);
        if (winner) return winner;
        throw new Error(`Xero org "${org}": lost a rotation race and the winner's chain is unusable; retry`);
      }
      if (!res.ok) throw new Error(`Xero org "${org}": token persist failed (${res.status}); NOT returning an unpersisted chain`);
    } else {
      try {
        await deps.create(CACHE_COLL, id, next);
      } catch (e) {
        const winner = await adoptWinner(deps, id, bHash);
        if (winner) return winner;
        throw e;
      }
    }
    return { accessToken: next.accessToken, tenantId: next.tenantId, tenantName: next.tenantName };
  });
}

// ---------------------------------------------------------------------------------------------
// API caller (read-only)
// ---------------------------------------------------------------------------------------------

/** Per-org soft rate spacing (Xero: 60 calls/min/org). In-memory per replica; reads are low-volume. */
const lastCallAt = new Map<string, number>();
const MIN_SPACING_MS = 1100;

export interface XeroGetResult {
  status: number;
  body: unknown;
  dayLimitRemaining: string | null;
  minuteLimitRemaining: string | null;
}

/**
 * GET a Xero Accounting API path for an org. Handles auth, tenant header, one forced-refresh retry
 * on 401, and rate-header surfacing. READ-ONLY on purpose: no method parameter exists.
 */
export async function xeroGet(
  org: XeroOrg,
  path: string,
  params: Record<string, string | undefined> = {},
  opts: { modifiedAfter?: string; deps?: TokenDeps } = {},
): Promise<XeroGetResult> {
  const deps = opts.deps ?? defaultDeps;
  if (!path.startsWith('/')) throw new Error('path must start with /');

  const wait = MIN_SPACING_MS - (Date.now() - (lastCallAt.get(org) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(org, Date.now());

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
  const url = `${XERO_API_BASE}${path}${qs.size ? `?${qs}` : ''}`;

  const attempt = async (force: boolean): Promise<Response> => {
    const { accessToken, tenantId } = await getOrgAccess(org, { forceRefresh: force, deps });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
    };
    if (opts.modifiedAfter) headers['If-Modified-Since'] = opts.modifiedAfter;
    return deps.fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  };

  let r = await attempt(false);
  if (r.status === 401) r = await attempt(true); // stale cached access token — refresh once and retry
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* some errors are plain text */
  }
  if (!r.ok && r.status !== 304) {
    throw new Error(`Xero GET ${path} (${org}) -> HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  return {
    status: r.status,
    body,
    dayLimitRemaining: r.headers.get('X-DayLimit-Remaining'),
    minuteLimitRemaining: r.headers.get('X-MinLimit-Remaining'),
  };
}

/** The ring-refusal payload shared by every xero_* tool. Pure. */
export function ringRefusal(toolName: string, caller: string | undefined | null) {
  return {
    data: { error: 'forbidden_ring' },
    summary:
      `Refused: ${toolName} serves MNPI financial data and requires an executive-ring lane ` +
      `(${EXEC_RING.join('/')}). Your identity: ${caller || '(none)'}. Never served to other lanes or external clients.`,
  };
}
