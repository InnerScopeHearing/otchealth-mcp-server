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
 * Default bound for extractXeroErrorDetail's return value, in characters. Applies to EVERY branch
 * (not only the raw-text fallback) so the function has one simple output-size contract: never
 * unbounded (defends against a pathological huge body), but generous enough that real Xero
 * ValidationException detail — realistically well under 1KB — never gets anywhere near it.
 *
 * (FND-20260724-68f5 residual, 2026-08-28: this was 2000 until a live CFO chart-of-accounts
 * incident — 5 varied POST /Accounts payloads — showed a Xero error body whose useful detail sat
 * past the old 2000-char raw-text-fallback boundary, cut off right before the actual cause. The
 * "clean shape" branch (Elements[].ValidationErrors[].Message) was already unbounded and NOT the
 * culprit; the fallback used for anything that doesn't match that exact shape was. 16KB is a
 * deliberately generous, still-bounded ceiling: real Xero bodies are one to a few KB even for a
 * multi-item batch create, so this practically never truncates a genuine response, while a
 * malformed or oversized body still cannot balloon a thrown Error.message without limit.)
 */
export const XERO_ERROR_DETAIL_MAX_CHARS = 16 * 1024;

/**
 * Extract the actual human-readable cause from a Xero error response body, when the body is a
 * Xero-shaped JSON error object. Xero's ValidationException shape nests the real reason inside
 * Elements[].ValidationErrors[].Message — the top-level Message is always the generic
 * "A validation exception occurred" boilerplate, so surfacing only the top-level text (or a
 * short slice of the raw body) throws away the one piece of information that actually explains
 * the failure. Falls back to a longer raw-text slice when the body isn't the expected shape, so
 * this never throws and never returns less information than before.
 * (FND-20260724-68f5: the previous fixed-length slice cut the response off before this detail.)
 *
 * THREE tiers, in order, each bounded by `maxChars` (default XERO_ERROR_DETAIL_MAX_CHARS):
 *   1. The expected shape (Elements[].ValidationErrors[].Message present) — the common case for a
 *      real ValidationException. Flattened into one readable string.
 *   2. JSON parses and carries a top-level Message but no per-element ValidationErrors text —
 *      returns that Message.
 *   3a. JSON parses, has a non-empty Elements array, but neither of the above yielded anything
 *       (e.g. a shape this function doesn't specifically know, or ValidationErrors present but
 *       empty on every element) — rather than silently discarding that structure into the SAME
 *       raw-text fallback used for genuinely non-JSON bodies, this preserves it VERBATIM via
 *       JSON.stringify(parsed.Elements): a caller (or an agent reading the tool result) can still
 *       see the real Elements array Xero returned, not nothing.
 *   3b. Anything else (not JSON, or JSON with no recognizable Xero error fields at all) — the
 *       original raw-text slice, now bounded at the wider ceiling above instead of 2000.
 */
export function extractXeroErrorDetail(rawText: string, maxChars = XERO_ERROR_DETAIL_MAX_CHARS): string {
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
      return `${top}${messages.join(' | ')}`.slice(0, maxChars);
    }
    if (parsed.Message) return parsed.Message.slice(0, maxChars);
    if (Array.isArray(parsed.Elements) && parsed.Elements.length) {
      // Xero-shaped JSON (has a Type/Elements envelope), but none of the fields this function
      // knows how to flatten were populated. Preserve the real structure rather than dropping to
      // the raw-text fallback below, which would treat perfectly good JSON as opaque text.
      return JSON.stringify(parsed.Elements).slice(0, maxChars);
    }
  } catch {
    /* not JSON (or not Xero's error shape) — fall through to the raw-text fallback below */
  }
  return rawText.slice(0, maxChars);
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
/** Record types an attachment can hang off, shared by the upload (write) and content (read) paths. */
export type XeroAttachmentEndpoint =
  | 'Invoices'
  | 'CreditNotes'
  | 'BankTransactions'
  | 'BankTransfers'
  | 'Payments'
  | 'ManualJournals'
  | 'Receipts'
  | 'Contacts'
  | 'PurchaseOrders';

export async function xeroUploadAttachment(
  org: XeroOrg,
  endpoint: XeroAttachmentEndpoint,
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
// Attachment CONTENT (read path) — the capability that did not exist: xero_attachments lists
// metadata (FileName/AttachmentID/MimeType/ContentLength/Url), but nothing ever fetched the bytes.
// ---------------------------------------------------------------------------------------------

/**
 * Max attachment CONTENT this gateway will read back from Xero and hand to a caller. Deliberately
 * SMALLER than MAX_ATTACHMENT_BYTES (the 10MB upload cap, ~line 589): a read response is base64-
 * encoded (~1.33x) and then JSON-serialized before result-store.ts's JIT auto-offload can even
 * attempt to store it off-band -- that path only fires below JIT_RESULT_MAX_CHARS (1.6M chars,
 * result-store.ts) and Cosmos itself caps a document at ~2MB. 1 MiB of raw bytes -> ~1.4M base64
 * chars, comfortably inside both ceilings with headroom left for the rest of the JSON envelope
 * (sha256, mimeType, path, etc). A payload allowed to exceed this would either fail to auto-offload
 * (silently falling back to a multi-MB inline blob) or bloat the offloaded Cosmos doc toward its own
 * cap -- neither is an acceptable way to learn about a large attachment, so this is refused loudly
 * (see the 'too_large' outcome below) rather than either silently truncating the file or shipping an
 * oversized response and hoping.
 */
export const MAX_ATTACHMENT_READ_BYTES = 1024 * 1024; // 1 MiB

/** Which field the caller supplied to select the attachment. AttachmentID is a Xero GUID (never
 *  needs encoding); FileName is caller-chosen text (spaces, parentheses, etc — MUST be encoded
 *  exactly once, see the URL construction below). */
export type XeroAttachmentIdentifier =
  | { by: 'fileName'; value: string }
  | { by: 'attachmentId'; value: string };

/**
 * Every distinct way this call can fail (or succeed), so the tool layer can surface each one as its
 * own loud, named `error` code instead of collapsing them into a generic message string. This
 * directly answers the failure class this codebase was bitten by six times on 2026-08-17/18 (see
 * FND-20260724-68f5 and the S3 double-encoding fix above isSafeBlobPath/fetchBlobFromS3): a 403 must
 * never be reported as "not found", a size cap must never be reported as "empty", and a corrupted /
 * misinterpreted body must never be reported as a successful read.
 *   'ok'                       real file bytes, verified against the response's own Content-Length
 *                              (when present) and never truncated.
 *   'not_found'                HTTP 404 — the record/attachment genuinely does not exist at this
 *                              endpoint/guid/identifier. Distinct from 'forbidden': a caller must
 *                              never treat a permissions failure as evidence a document is missing.
 *   'forbidden'                HTTP 403 — Xero refused the request (scope/tenant/permission). NEVER
 *                              conflated with 'not_found' (unlike the S3 mirror's 403-as-404
 *                              convenience, which is safe there only because S3 itself conflates
 *                              missing-vs-denied for a bucket without ListBucket — Xero does not).
 *   'auth_failed'              still 401 after one forced token-refresh retry (the same retry
 *                              xeroGet/xeroRequest perform) — an org-level token problem, not a
 *                              per-file one.
 *   'too_large'                the content exceeds MAX_ATTACHMENT_READ_BYTES. Caught EITHER before
 *                              downloading (via a declared Content-Length header, PASS 1) or DURING
 *                              a streaming read (PASS 2, defense in depth against a missing/lying
 *                              header — e.g. chunked transfer-encoding or a compressing proxy that
 *                              strips Content-Length) — never by returning a truncated prefix, and
 *                              (2026-08-18 fix) never by first buffering the whole oversized body
 *                              into memory before refusing it. See `truncatedEarly` below.
 *   'unexpected_content_type'  the request asked for the wildcard Accept value (never
 *                              'application/json' — see the header comment below) and got a 2xx,
 *                              but the response's own
 *                              Content-Type is application/json anyway. Per Xero's documented
 *                              behavior that means Xero served the ATTACHMENT-METADATA
 *                              representation, not the file — silently handing that back labeled
 *                              as "the file" would be exactly the false-plausible-value failure
 *                              this whole path exists to avoid.
 *   'xero_error'                any other non-2xx status.
 */
export type XeroAttachmentContentOutcome =
  | { kind: 'ok'; status: number; bytes: Buffer; contentType: string; byteLength: number }
  | { kind: 'not_found'; status: number; detail: string }
  | { kind: 'forbidden'; status: number; detail: string }
  | { kind: 'auth_failed'; status: number; detail: string }
  | {
      kind: 'too_large';
      contentLengthHeader: string | null;
      actualBytes: number | null;
      cap: number;
      // TRUE when `actualBytes` is a LOWER BOUND (the streaming read was cancelled the instant the
      // running total was known to exceed the cap — the rest of the body was never pulled, so the
      // file's real total size is genuinely unknown, only "at least actualBytes"). FALSE when
      // `actualBytes`/the header value is the exact/declared size (PASS 1's declared-Content-Length
      // refusal, or the r.body-unavailable fallback that reads the whole body via arrayBuffer()).
      // A caller must not treat `actualBytes` as the file's real size when this is true.
      truncatedEarly: boolean;
    }
  | { kind: 'unexpected_content_type'; status: number; contentType: string; bodyPreview: string }
  | { kind: 'xero_error'; status: number; detail: string };

/**
 * Streams a fetch Response's body, accumulating chunks only up to `limitBytes` — the actual fix for
 * the "declared Content-Length absent -> the whole body gets buffered before being size-checked"
 * defect (PASS 1 in xeroGetAttachmentContent only fires when Xero DECLARES a length up front; a
 * chunked-transfer-encoding or compressing-proxy response has none, and the old code unconditionally
 * called `r.arrayBuffer()` — fully materializing an arbitrarily large attachment in memory on a
 * shared multi-replica gateway before ever checking its size).
 *
 * The moment the running total exceeds `limitBytes`, this STOPS pulling more chunks and cancels the
 * reader (`reader.cancel()`) rather than draining the rest of the stream — bounding memory use to
 * roughly one chunk past the limit, never the full oversized body. `cancelledEarly:true` marks
 * exactly this case, so the caller can tell "we stopped early, this total is a lower bound" apart
 * from "we read the whole thing and it happens to be over/under the limit".
 *
 * Falls back to `r.arrayBuffer()` when `r.body` has no usable Streams-API reader — some fetch mocks
 * / older polyfills / test doubles do not implement `ReadableStream.getReader()` on `Response.body`
 * even though they implement `arrayBuffer()`. This preserves the OLD (correct, just unbounded)
 * behavior for those callers rather than throwing; `cancelledEarly` is always false on this path
 * because the whole body genuinely was read (the returned length is exact, not a lower bound).
 */
async function readStreamBounded(r: Response, limitBytes: number): Promise<{ bytes: Buffer; exceededLimit: boolean; cancelledEarly: boolean }> {
  // Typed straight off Response.body (no explicit ReadableStream<T> annotation needed/wanted here —
  // this repo's tsconfig has no "dom" lib, so relying on the ambient global would be fragile; letting
  // TS infer from the fetch-types' own Response.body declaration is the robust choice).
  const body = r.body;
  if (!body || typeof body.getReader !== 'function') {
    const bytes = Buffer.from(await r.arrayBuffer());
    return { bytes, exceededLimit: bytes.length > limitBytes, cancelledEarly: false };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let cancelledEarly = false;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream is inherently sequential; there is no
    // batch of reads to parallelize here.
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    total += chunk.length;
    if (total > limitBytes) {
      // STOP HERE — never call reader.read() again, never call r.arrayBuffer(). A rejected cancel()
      // (e.g. the underlying stream already errored/closed) is harmless to swallow: this function is
      // refusing the read regardless of whether cancel() itself succeeds cleanly.
      cancelledEarly = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { bytes: Buffer.concat(chunks), exceededLimit: total > limitBytes, cancelledEarly };
}

/**
 * A JSON-labeled 2xx response is NEVER the file (see 'unexpected_content_type' above) — so refusing
 * it never needs the whole body, only enough bytes to build the existing ~2000-char `bodyPreview`.
 * Deliberately generous vs. that 2000-char slice (multi-byte UTF-8 sequences can straddle a chunk
 * boundary) while still being a tiny, fixed bound — a mislabeled multi-megabyte "JSON" response is
 * refused just as cheaply as a genuinely small one.
 */
const JSON_PREVIEW_READ_BYTES = 8192;

/**
 * Fetch the RAW BYTES of one attachment. This is the actual Xero Attachments API content-retrieval
 * contract, which is categorically different from every JSON read in this file (xeroGet):
 *
 *  - xeroGet (~line 473) unconditionally sends `Accept: application/json` (~line 496) and always
 *    calls `r.text()` then `JSON.parse()` (~line 504-507). Per Xero's documented Attachments
 *    behavior, sending `Accept: application/json` to this specific content endpoint returns the
 *    ATTACHMENT-METADATA JSON object (AttachmentID/FileName/ContentLength/...), not the file — so
 *    reusing xeroGet here would not even reach the bytes. And even if it somehow did, `.text()`
 *    decodes the response as UTF-8: for a PDF/PNG/DOCX that operation is LOSSY (invalid byte
 *    sequences are replaced with U+FFFD) and irreversible — the original bytes are gone. Neither
 *    xeroGet nor xeroRequest is safe to route this through; hence this dedicated function, using
 *    `r.arrayBuffer()` on the success path and never calling `.text()`/`JSON.parse()` on binary
 *    content (mirrors the same fix already applied to the upload direction, xeroUploadAttachment
 *    above, and to fetchBlobFromS3 in ../../legal/s3-blob-store.ts for the identical reason).
 *
 *  - Accept defaults to the wildcard value (any type), NEVER `'application/json'`, so Xero serves
 *    the file's own representation (its real Content-Type) rather than the metadata JSON. A caller
 *    that already knows the attachment's mime type (e.g. from a prior xero_attachments listing) may
 *    supply it as `opts.mimeTypeHint` — it is then sent AHEAD of the wildcard (`Accept: <hint>,
 *    * / *`), matching the public xero-node SDK's precedent of setting Accept to the attachment's own
 *    type. This is an UNVERIFIED-AGAINST-LIVE-XERO improvement, not a required fix: the wildcard-only
 *    behavior already fails safe (a JSON-labeled response is caught as 'unexpected_content_type'
 *    below, never silently corrupted), so an absent/omitted hint changes nothing from before.
 *
 * ENCODING (the double-encoding footgun this repo hit today, 2026-08-17/18, in fetchBlobFromS3's
 * S3-key case): the identifier is percent-encoded EXACTLY ONCE via encodeURIComponent when building
 * the URL below — never pre-encoded and then encoded again. Unlike the S3/SigV4 case, Xero's REST
 * API needs no second, service-specific encoding pass, so a single encodeURIComponent is correct and
 * sufficient here; a FileName containing a space becomes `%20` on the wire, never `%2520`. An
 * AttachmentID (a GUID) needs no encoding at all — encodeURIComponent is a safe no-op on it — which
 * is exactly why AttachmentID is the SAFER identifier to prefer when the caller has one (see
 * XeroAttachmentIdentifier / xero_attachment_content's tool description): there is no encoding
 * footgun to get right in the first place.
 *
 * MEMORY (2026-08-18 fix): the actual file bytes are read via `readStreamBounded` (STREAMING, capped
 * at MAX_ATTACHMENT_READ_BYTES), never an unconditional `r.arrayBuffer()` — see that function's
 * header comment for why. `r.arrayBuffer()` is still used, but only for the non-2xx error-text
 * branch immediately below (Xero's own small error body) and as readStreamBounded's own internal
 * fallback when a fetch impl's Response.body has no usable stream reader.
 */
export async function xeroGetAttachmentContent(
  org: XeroOrg,
  endpoint: XeroAttachmentEndpoint,
  guid: string,
  identifier: XeroAttachmentIdentifier,
  opts: { deps?: TokenDeps; mimeTypeHint?: string } = {},
): Promise<XeroAttachmentContentOutcome> {
  const deps = opts.deps ?? defaultDeps;
  const mimeTypeHint = opts.mimeTypeHint?.trim();

  const wait = MIN_SPACING_MS - (Date.now() - (lastCallAt.get(org) ?? 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(org, Date.now());

  const url = `${XERO_API_BASES.accounting}/${endpoint}/${encodeURIComponent(guid)}/Attachments/${encodeURIComponent(identifier.value)}`;

  const attempt = async (force: boolean): Promise<Response> => {
    const { accessToken, tenantId } = await getOrgAccess(org, { forceRefresh: force, deps });
    return deps.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        // THE ACTUAL FIX (see this function's header comment): never 'application/json' here — that
        // is what makes Xero serve metadata instead of the file on this specific endpoint. A caller-
        // supplied hint (when present) rides AHEAD of the wildcard; omitting it is byte-for-byte the
        // same header this endpoint has always sent.
        Accept: mimeTypeHint ? `${mimeTypeHint}, */*` : '*/*',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  };

  let r = await attempt(false);
  if (r.status === 401) r = await attempt(true); // stale cached access token — refresh once and retry

  if (!r.ok) {
    // Non-2xx bodies here are Xero's own error text/JSON, never file content — safe to decode as
    // text. This branch is reached for 401 (still, after the forced-refresh retry above), 403, 404,
    // and everything else, and returns a DISTINCT `kind` for each so the caller can never conflate
    // "forbidden" with "not found" with "some other failure".
    const text = await r.text();
    const detail = extractXeroErrorDetail(text);
    if (r.status === 404) return { kind: 'not_found', status: r.status, detail };
    if (r.status === 403) return { kind: 'forbidden', status: r.status, detail };
    if (r.status === 401) return { kind: 'auth_failed', status: r.status, detail };
    return { kind: 'xero_error', status: r.status, detail };
  }

  // SIZE CAP, PASS 1 (before consuming the body): when Xero declares Content-Length up front and it
  // already exceeds the cap, refuse without downloading the file at all. `truncatedEarly:false` here
  // because the declared header value is an exact number Xero itself gave us, not a partial read.
  const declaredLength = r.headers.get('content-length');
  const declaredNum = declaredLength ? Number(declaredLength) : NaN;
  if (Number.isFinite(declaredNum) && declaredNum > MAX_ATTACHMENT_READ_BYTES) {
    await r.body?.cancel?.().catch(() => undefined);
    return { kind: 'too_large', contentLengthHeader: declaredLength, actualBytes: null, cap: MAX_ATTACHMENT_READ_BYTES, truncatedEarly: false };
  }

  const contentType = r.headers.get('content-type') || '';

  if (contentType.toLowerCase().startsWith('application/json')) {
    // A 2xx with a JSON content-type despite requesting '*/*' (or a hint) is not the documented
    // behavior for this endpoint — treat it as a distinct anomaly rather than silently handing back
    // JSON bytes mislabeled as "the file" (a plausible-looking wrong value is worse than a refusal
    // here). This is NEVER the file, so only a small BOUNDED read is needed to build the preview —
    // see JSON_PREVIEW_READ_BYTES's header comment; a large mislabeled response is refused just as
    // cheaply as a small one, never fully buffered first.
    const { bytes: previewBytes } = await readStreamBounded(r, JSON_PREVIEW_READ_BYTES);
    return {
      kind: 'unexpected_content_type',
      status: r.status,
      contentType,
      bodyPreview: previewBytes.toString('utf8').slice(0, 2000),
    };
  }

  // SIZE CAP, PASS 2 — STREAMING (2026-08-18 fix): this is the actual defense-in-depth pass for a
  // missing/understated Content-Length (e.g. chunked transfer-encoding, a compressing proxy). The OLD
  // code called `r.arrayBuffer()` unconditionally here, which fully materializes the entire body in
  // memory BEFORE the size is ever checked — on a shared multi-replica gateway, an attachment with no
  // declared length was fully downloaded even when it was going to be refused anyway.
  // `readStreamBounded` accumulates chunks and cancels the reader the MOMENT the running total is
  // known to exceed the cap, so an oversized body is never fully buffered. NEVER return a truncated
  // prefix of an oversized file as though it were the whole thing — that is a silently corrupted
  // document, exactly the "failure returned as a plausible value" pattern this whole path exists to
  // avoid; refusing loudly (with `actualBytes` as an honest LOWER BOUND, flagged via
  // `truncatedEarly`) is the only acceptable outcome here.
  const { bytes, exceededLimit, cancelledEarly } = await readStreamBounded(r, MAX_ATTACHMENT_READ_BYTES);
  if (exceededLimit) {
    return {
      kind: 'too_large',
      contentLengthHeader: declaredLength,
      actualBytes: bytes.length,
      cap: MAX_ATTACHMENT_READ_BYTES,
      truncatedEarly: cancelledEarly,
    };
  }

  return {
    kind: 'ok',
    status: r.status,
    bytes,
    contentType: contentType || 'application/octet-stream',
    byteLength: bytes.length,
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
