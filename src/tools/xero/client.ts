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
} from '../../agentstate/store.js';

/** Bounded network deadline for every Xero call — a hung refresh must never wedge a replica. */
const FETCH_TIMEOUT_MS = 15000;

export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
/**
 * The five Xero product APIs the consented scopes reach. Each is a separate base path but all share
 * the OAuth2 bearer + Xero-tenant-id header + rate-limit headers, so one xeroGet serves them all.
 *   accounting: settings/contacts/attachments/budgets/payments/invoices/creditnotes/banktransactions/
 *               banktransfers/manualjournals + all Reports (api.xro/2.0)
 *   payroll:    US payroll employees/payruns/payslips/timesheets/settings (payroll.xro/1.0)
 *   assets:     fixed-asset register (assets.xro/1.0)
 *   projects:   projects/tasks/time (projects.xro/2.0)
 *   files:      files/folders/associations (files.xro/1.0)
 */
export const XERO_API_BASES = {
  accounting: 'https://api.xero.com/api.xro/2.0',
  payroll: 'https://api.xero.com/payroll.xro/1.0',
  assets: 'https://api.xero.com/assets.xro/1.0',
  projects: 'https://api.xero.com/projects.xro/2.0',
  files: 'https://api.xero.com/files.xro/1.0',
} as const;
export type XeroApi = keyof typeof XERO_API_BASES;

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
      // REPORT THE VENDOR'S ERROR, NOT A GUESS ABOUT ITS CAUSE.
      //
      // This line used to read `invalid_grant (chain consumed elsewhere or expired)`. Xero returns a
      // bare `invalid_grant`; the parenthetical was OUR hypothesis, baked into a log message years
      // before the incident it was read during. On 2026-08-17 the CFO reasonably took it as a
      // finding and escalated a second-consumer-burning-tokens root cause -- then had to retract it.
      // `invalid_grant` is generic: it covers rotation-consumption, 60-day idle expiry, org-side
      // disconnection, revocation, and the app falling out of good standing. The cause CANNOT be
      // read off the error code, so a tool that states one manufactures a false lead, and a false
      // lead costs more than no lead.
      //
      // What actually distinguished the causes was evidence this string could never carry: ALL FOUR
      // orgs died at once, including one that had been idle. That is an app-level event, not four
      // independent token races. The remediation is identical either way, so nothing is lost by
      // dropping the causal claim -- only the wrong inference is.
      dead.deadReason = `invalid_grant (as returned by Xero; cause not determinable from this code)`;
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
        // Residual-race repair: the racer may have written a same-family DEAD tombstone (which holds
        // NO token material) just before us. We hold a freshly-VALIDATED live grant, so REVIVE it
        // (replace the tombstone with our live chain) rather than discard a valid rotation and force
        // a needless re-consent. Safe because a tombstone carries no token; bounded to one attempt.
        const cur = await deps.read(CACHE_COLL, id, id);
        const cdoc = cur?.doc as XeroTokenDoc | undefined;
        if (cur?.etag && cdoc?.status === 'dead' && cdoc.bootstrapHash === bHash) {
          const revived = await deps.replace(CACHE_COLL, id, id, next, cur.etag);
          if (revived.ok) return { accessToken: next.accessToken, tenantId: next.tenantId, tenantName: next.tenantName };
          const w2 = await adoptWinner(deps, id, bHash);
          if (w2) return w2;
        }
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
 * Extract the actual human-readable cause from a Xero error response body, when the body is a
 * Xero-shaped JSON error object. Xero's ValidationException shape nests the real reason inside
 * Elements[].ValidationErrors[].Message — the top-level Message is always the generic
 * "A validation exception occurred" boilerplate, so surfacing only the top-level text (or a
 * short slice of the raw body) throws away the one piece of information that actually explains
 * the failure. Falls back to a longer raw-text slice when the body isn't the expected shape, so
 * this never throws and never returns less information than before.
 * (FND-20260724-68f5: the previous fixed-length slice cut the response off before this detail.)
 */
export function extractXeroErrorDetail(rawText: string, maxRawFallbackChars = 2000): string {
  try {
    const parsed = JSON.parse(rawText) as {
      Type?: string;
      Message?: string;
      Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>;
    };
    const messages: string[] = [];
    if (Array.isArray(parsed.Elements)) {
      for (const el of parsed.Elements) {
        for (const ve of el.ValidationErrors ?? []) {
          if (ve.Message) messages.push(ve.Message);
        }
      }
    }
    if (messages.length) {
      const top = parsed.Message ? `${parsed.Message}: ` : '';
      return `${top}${messages.join(' | ')}`;
    }
    if (parsed.Message) return parsed.Message;
  } catch {
    /* not JSON (or not Xero's error shape) — fall through to the raw-text fallback below */
  }
  return rawText.slice(0, maxRawFallbackChars);
}

/**
 * GET a path on one of the Xero product APIs for an org (opts.api selects the base; default
 * 'accounting'). Handles auth, tenant header, one forced-refresh retry on 401, and rate-header
 * surfacing. READ-ONLY on purpose: no method parameter exists, so no path can mutate the books.
 */
export async function xeroGet(
  org: XeroOrg,
  path: string,
  params: Record<string, string | undefined> = {},
  opts: { modifiedAfter?: string; deps?: TokenDeps; api?: XeroApi } = {},
): Promise<XeroGetResult> {
  const deps = opts.deps ?? defaultDeps;
  if (!path.startsWith('/')) throw new Error('path must start with /');

  const wait = MIN_SPACING_MS - (Date.now() - (lastCallAt.get(org) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(org, Date.now());

  const base = XERO_API_BASES[opts.api ?? 'accounting'];
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
  const url = `${base}${path}${qs.size ? `?${qs}` : ''}`;

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
    // FND-20260724-68f5 fix: surface the real ValidationErrors detail, not a fixed-length slice
    // of raw text that cut off before the actual cause every time.
    throw new Error(`Xero GET ${path} (${org}) -> HTTP ${r.status}: ${extractXeroErrorDetail(text)}`);
  }
  return {
    status: r.status,
    body,
    dayLimitRemaining: r.headers.get('X-DayLimit-Remaining'),
    minuteLimitRemaining: r.headers.get('X-MinLimit-Remaining'),
  };
}

/**
 * POST / PUT / DELETE a path on a Xero product API for an org — the WRITE path. Same auth, tenant
 * header, one-forced-refresh-on-401 retry, and rate-header surfacing as xeroGet, but sends a method
 * + JSON body. The CFO seat is authorized for full read+write on the books (Matt directive
 * 2026-07-16). NOTE: Xero writes are BOOKKEEPING — they post to the ledger; they do not move real
 * money (bank execution happens at the bank, not here).
 */
export async function xeroRequest(
  org: XeroOrg,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  params: Record<string, string | undefined> = {},
  opts: { deps?: TokenDeps; api?: XeroApi } = {},
): Promise<XeroGetResult> {
  const deps = opts.deps ?? defaultDeps;
  if (!path.startsWith('/')) throw new Error('path must start with /');

  const wait = MIN_SPACING_MS - (Date.now() - (lastCallAt.get(org) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(org, Date.now());

  const base = XERO_API_BASES[opts.api ?? 'accounting'];
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
  const url = `${base}${path}${qs.size ? `?${qs}` : ''}`;
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const attempt = async (force: boolean): Promise<Response> => {
    const { accessToken, tenantId } = await getOrgAccess(org, { forceRefresh: force, deps });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    return deps.fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  };

  let r = await attempt(false);
  if (r.status === 401) r = await attempt(true); // stale cached access token — refresh once and retry
  const text = await r.text();
  let respBody: unknown = text;
  try {
    respBody = JSON.parse(text);
  } catch {
    /* 204 No Content and some errors are non-JSON */
  }
  if (!r.ok) {
    // FND-20260724-68f5 fix: same real-detail extraction as xeroGet, not a fixed-length raw slice.
    throw new Error(`Xero ${method} ${path} (${org}) -> HTTP ${r.status}: ${extractXeroErrorDetail(text)}`);
  }
  return {
    status: r.status,
    body: respBody,
    dayLimitRemaining: r.headers.get('X-DayLimit-Remaining'),
    minuteLimitRemaining: r.headers.get('X-MinLimit-Remaining'),
  };
}

/** Max attachment size this gateway will forward to Xero. Xero's own documented limit is 25MB per
 * file; we cap well under that (10MB) since the gateway also has to hold the decoded buffer and
 * relay it within FETCH_TIMEOUT_MS. Reject client-side with a clear error rather than let a huge
 * base64 payload time out or 500 partway through (FND-20260724-f6df: a 7.8MB payload previously
 * failed as an opaque gateway internal_error with no explanation). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Upload a source-document attachment to a Xero accounting record — the ACTUAL Xero Attachments
 * API contract, which is categorically different from every other write in this file: Xero expects
 * the RAW FILE BYTES as the request body with the file's own Content-Type header (e.g.
 * "application/pdf", "image/png") on PUT/POST to /{Endpoint}/{Guid}/Attachments/{FileName} — NOT a
 * JSON-wrapped payload. xeroRequest() above unconditionally sends `Content-Type: application/json`
 * and JSON.stringifies whatever body it's given, so routing an attachment through it silently sends
 * Xero a JSON blob instead of a file: small payloads round-trip a plausible-looking 200 + AttachmentID
 * (Xero creates the attachment record but the "file" is the JSON text, not real content) while larger
 * ones fail outright once Xero's own size/content validation kicks in. This is the confirmed root
 * cause of FND-20260724-f6df (verified independently via xero_attachments showing Attachments:[] on
 * every prior attempt, at every size tried).
 *
 * Uses PUT (Xero's documented method for attachment upload; creates on first call, replaces on a
 * repeat call with the same filename — safer than POST's create-a-duplicate-on-retry behavior for
 * this specific endpoint).
 */
export async function xeroUploadAttachment(
  org: XeroOrg,
  endpoint: 'Invoices' | 'CreditNotes' | 'BankTransactions' | 'BankTransfers' | 'Payments' | 'ManualJournals' | 'Receipts' | 'Contacts' | 'PurchaseOrders',
  guid: string,
  fileName: string,
  contentBytes: Buffer,
  mimeType: string,
  opts: { deps?: TokenDeps } = {},
): Promise<XeroGetResult> {
  const deps = opts.deps ?? defaultDeps;
  if (contentBytes.length === 0) throw new Error('xeroUploadAttachment: empty file content');
  if (contentBytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `xeroUploadAttachment: ${contentBytes.length} bytes exceeds this gateway's ${MAX_ATTACHMENT_BYTES} byte cap ` +
        `(Xero's own limit is 25MB; this gateway caps lower for reliable relay within its request timeout). ` +
        `Split the document or host it externally and attach a link instead.`,
    );
  }

  const wait = MIN_SPACING_MS - (Date.now() - (lastCallAt.get(org) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(org, Date.now());

  const url = `${XERO_API_BASES.accounting}/${endpoint}/${encodeURIComponent(guid)}/Attachments/${encodeURIComponent(fileName)}`;

  const attempt = async (force: boolean): Promise<Response> => {
    const { accessToken, tenantId } = await getOrgAccess(org, { forceRefresh: force, deps });
    return deps.fetchImpl(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
        // THE ACTUAL FIX: the file's real Content-Type, and the raw bytes as the body — never
        // application/json, never a JSON-stringified wrapper object.
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Length': String(contentBytes.length),
      },
      body: contentBytes,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  };

  let r = await attempt(false);
  if (r.status === 401) r = await attempt(true);
  const text = await r.text();
  let respBody: unknown = text;
  try {
    respBody = JSON.parse(text);
  } catch {
    /* non-JSON error bodies happen */
  }
  if (!r.ok) {
    throw new Error(`Xero attachment upload ${endpoint}/${guid}/${fileName} (${org}) -> HTTP ${r.status}: ${extractXeroErrorDetail(text)}`);
  }
  return {
    status: r.status,
    body: respBody,
    dayLimitRemaining: r.headers.get('X-DayLimit-Remaining'),
    minuteLimitRemaining: r.headers.get('X-MinLimit-Remaining'),
  };
}

// ---------------------------------------------------------------------------------------------
// Connections metadata (CFO P0-1/P0-4, 2026-07-30): which grant is this, and when was it created?
// ---------------------------------------------------------------------------------------------

export interface XeroConnection {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantType: string;
  createdDateUtc: string;
  updatedDateUtc: string;
}

/**
 * The vendor-documented cutoff (CFO P0-1, 2026-07-30, sourced to Xero's own developer docs): a
 * Custom Connection created BEFORE this date retains accounting.journals.read (grandfathered)
 * until Sep 2027; one created on/after this date can never obtain that scope at any price. This
 * constant is the one fact xero_connections exists to let us check per org, cheaply and
 * repeatedly, without re-deriving the date from memory each time.
 */
export const XERO_JOURNALS_GRANDFATHER_CUTOFF = '2026-04-29T00:00:00Z';

/**
 * Raw GET /connections for whichever org's access token is used — returns the connection grant(s)
 * reachable by that token (id, tenant identity, and createdDateUtc/updatedDateUtc). This is the
 * ONLY Xero-API-exposed way to learn a connection's creation date; Xero does NOT expose "which
 * user authorised this connection" via any API (that is only visible in the Xero UI under
 * Settings > Connected Apps, to a user who can see the org's app list) — callers needing that fact
 * must check there, this function cannot supply it.
 */
export async function xeroConnections(org: XeroOrg, opts: { deps?: TokenDeps } = {}): Promise<XeroConnection[]> {
  const deps = opts.deps ?? defaultDeps;
  const { accessToken } = await getOrgAccess(org, { deps });
  const r = await deps.fetchImpl(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Xero /connections failed for org "${org}": HTTP ${r.status}`);
  const conns = (await r.json()) as Array<Partial<XeroConnection>>;
  return conns.map((c) => ({
    id: c.id ?? '',
    tenantId: c.tenantId ?? '',
    tenantName: c.tenantName ?? '',
    tenantType: c.tenantType ?? '',
    createdDateUtc: c.createdDateUtc ?? '',
    updatedDateUtc: c.updatedDateUtc ?? '',
  }));
}

/**
 * ALWAYS returns null. Kept as an explicit function (not deleted) so the "this cannot be
 * determined" fact has one place to live and cannot silently regress back into a false answer.
 *
 * Reviewer-caught correctness bug (2026-07-30): this used to compare createdDateUtc against
 * XERO_JOURNALS_GRANDFATHER_CUTOFF and return true/false. That is WRONG for two independent
 * reasons, either one enough to make the answer unsafe to act on for an irreversible P0-1
 * decision: (1) Xero's documented April-29 grandfather rule applies specifically to CUSTOM
 * CONNECTIONS (a client_credentials-grant app type) — this gateway's token path
 * (refreshGrant() above) uses the refresh_token/authorization_code grant, which is evidence this
 * integration is a STANDARD OAuth2 app, not a Custom Connection, and the rule may not apply to it
 * at all in the way assumed. (2) /connections exposes NO field that identifies connection TYPE
 * (Custom Connection vs standard app) — createdDateUtc alone cannot distinguish them, so even a
 * pre-cutoff standard-app tenant would have been mislabeled "grandfathered" for a scope path it
 * was never eligible for. A false `true` here is actively dangerous: P0-1's whole point is
 * avoiding an IRREVERSIBLE loss of journals-scope eligibility, and a wrong "you're safe" is worse
 * than no answer. Determining the real connection type requires checking the Xero Developer
 * Portal / My Apps page directly (see xero_connections' tool description) — not this API.
 */
export function isGrandfatheredForJournals(_createdDateUtc: string): null {
  return null;
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
