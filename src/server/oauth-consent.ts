/**
 * The OAuth consent interstitial: pending-authorization storage + the self-contained HTML page,
 * wired into GET/POST /oauth/authorize by server/oauth.ts. Split into its own file (mirroring
 * server/heygen-pairing.ts's thin-route / tools/heygen/broker.ts's fat-logic split) so oauth.ts's
 * diff for this feature stays small and reviewable -- it is the gateway's most security-critical
 * file, and this is the exact class of change (who gets a privileged token) a hostile reviewer
 * needs to be able to verify quickly.
 *
 * ============================ WHY AN INTERSTITIAL AT ALL ============================
 * ChatGPT and Claude custom connectors connect by URL only: they self-register via DCR at
 * POST /register and then run authorization-code + PKCE against GET /oauth/authorize, with no way
 * to hand-carry a client secret. server/oauth.ts hard-binds every such client to the non-privileged
 * 'external-read' lane at /register (the July 2026 P0 fix -- see that file's Part 6 comment) and
 * that MUST remain the default. This page is the proven pattern (Sentry's mcp.sentry.dev,
 * Cloudflare, Linear) for adding a privileged path on top of that default without reopening it: an
 * approval screen shown by the AUTH SERVER itself, mid-flow, in the OWNER's own browser, where
 * elevation requires a genuine owner-held secret (auth/setup-codes.ts) that the connecting client
 * never has and never sees.
 *
 * ============================ THE PENDING-AUTH RECORD ============================
 * GET /oauth/authorize, for a public (DCR) client only, does NOT auto-issue a code. It stores a
 * pending-auth doc (this file) carrying everything the eventual code issuance needs -- client_id,
 * redirect_uri, state, the PKCE challenge -- and renders a page whose form posts back ONLY the
 * pending-auth id plus the owner's choice. THE FORM NEVER CARRIES redirect_uri/state/PKCE: the POST
 * handler resolves all of that from the stored record, not from anything the submitted form claims,
 * so a tampered hidden field cannot redirect the flow anywhere the original GET request did not
 * already validate.
 *
 * Two independent budgets bound the record: a TTL kept in lockstep with auth/setup-codes.ts's own
 * DEFAULT_TTL_MINUTES (see PENDING_TTL_MS below -- this used to be a separately hardcoded 10 minutes,
 * SHORTER than the setup-code's own default 30-minute TTL, which was a real, user-visible dead-end
 * bug: a code fetched just after the pending page loaded could still be perfectly valid while the
 * page itself had already died), and MAX_SETUP_CODE_ATTEMPTS (5) wrong codes before the record is
 * permanently burned (resolveElevateChoice below) -- checked and
 * persisted with the SAME read -> mutate -> replace(ifMatch) -> retry-on-412 shape auth/setup-codes.ts uses,
 * so two concurrent wrong-guess submissions against the SAME pending id cannot each be counted as
 * "attempt 1 of 5" and together exceed the cap unnoticed.
 *
 * ============================ FAIL-LOUD, NEVER A SILENT BYPASS ============================
 * A genuine storage failure while resolving a pending-auth record, or while checking/burning an
 * attempt, is reported as 'store_error' (mapped to an HTTP 500 neutral page by oauth.ts) -- it never
 * falls through to issuing a code at ANY privilege level. Falling back to the safe, no-elevation
 * outcome is acceptable ONLY on the explicit, code-free "connect read-only" choice
 * (resolveReadOnlyChoice below), which never touches auth/setup-codes.ts and never fails "up" into
 * a privileged grant --
 * there is no parameter or state transition anywhere in this file that lets a code-verification
 * failure resolve into anything other than 'retry' (wrong code, budget remains), 'burned' (budget
 * exhausted or record already gone), or 'store_error' (infrastructure problem). None of those three
 * outcomes ever produces an issued code.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import {
  createDoc,
  deleteDoc,
  isConfigured as agentStateConfigured,
  readDoc,
  replaceDoc,
} from '../agentstate/store.js';
import {
  DEFAULT_TTL_MINUTES,
  consumeSetupCode,
  defaultSetupCodeDeps,
  type SetupCodeDeps,
} from '../auth/setup-codes.js';

const CACHE_CONTAINER = 'cache';
const PENDING_KIND = 'connector-pending-auth';
const DOC_ID_PREFIX = 'connector-pending-auth_';
// Derived from auth/setup-codes.ts's own DEFAULT_TTL_MINUTES (the setup-code TTL a mint gets when it
// does not pass ttl_minutes) rather than a second hardcoded number, so the two clocks can never again
// drift out of lockstep. A shorter pending-auth window than the code's own default TTL is invisible
// until it actually bites: the owner fetches a still-valid code, comes back, submits it, and lands on
// a dead page anyway even though the code itself was never expired. A unit test in
// oauth-consent.test.ts pins this equality directly so a future edit to either constant cannot
// silently reopen the gap.
const PENDING_TTL_MS = DEFAULT_TTL_MINUTES * 60 * 1000;
export const MAX_SETUP_CODE_ATTEMPTS = 5;
/** External-facing pending_id charset: 16 random bytes, hex-encoded (see newPendingAuthId). */
const PENDING_ID_RE = /^[a-f0-9]{32}$/;

export interface PendingAuthDoc extends Record<string, unknown> {
  id: string;
  cacheScope: string;
  kind: typeof PENDING_KIND;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  createdAt: string;
  expiresAt: string;
  attempts: number;
  burned: boolean;
}

function isPendingAuthDoc(value: unknown): value is PendingAuthDoc {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<PendingAuthDoc>;
  return (
    typeof d.id === 'string' &&
    d.cacheScope === d.id &&
    d.kind === PENDING_KIND &&
    typeof d.clientId === 'string' &&
    typeof d.redirectUri === 'string' &&
    (d.state === null || typeof d.state === 'string') &&
    typeof d.codeChallenge === 'string' &&
    d.codeChallengeMethod === 'S256' &&
    typeof d.createdAt === 'string' &&
    typeof d.expiresAt === 'string' &&
    Number.isFinite(Date.parse(d.expiresAt)) &&
    typeof d.attempts === 'number' &&
    typeof d.burned === 'boolean'
  );
}

export interface OAuthConsentDeps {
  now: () => number;
  randomBytesImpl: (size: number) => Buffer;
  create: typeof createDoc;
  read: typeof readDoc;
  replace: typeof replaceDoc;
  delete: typeof deleteDoc;
  configured: () => boolean;
}

export const defaultOAuthConsentDeps: OAuthConsentDeps = {
  now: () => Date.now(),
  randomBytesImpl: randomBytes,
  create: createDoc,
  read: readDoc,
  replace: replaceDoc,
  delete: deleteDoc,
  configured: agentStateConfigured,
};

/** The bare, external-facing pending id (32 hex chars, 128 bits). The doc id used in storage
 *  additionally namespaces it (docId below) so it can never collide with another feature's rows in
 *  the shared `cache` container. */
export function newPendingAuthId(randomBytesImpl: (size: number) => Buffer = randomBytes): string {
  return randomBytesImpl(16).toString('hex');
}

export function isValidPendingAuthId(value: string): boolean {
  return PENDING_ID_RE.test(value);
}

function docId(pendingId: string): string {
  return `${DOC_ID_PREFIX}${pendingId}`;
}

export interface CreatePendingAuthInput {
  clientId: string;
  redirectUri: string;
  state?: string | null;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/** Create a pending-auth record. Throws on a genuine store failure or exhausted id-collision
 *  retries (both astronomically unlikely at 128 bits) -- the caller (oauth.ts) must treat that as a
 *  loud failure, never fall through to auto-issuing a code. */
export async function createPendingAuth(
  input: CreatePendingAuthInput,
  deps: OAuthConsentDeps = defaultOAuthConsentDeps,
): Promise<{ id: string; expiresAt: string }> {
  if (!deps.configured()) {
    throw new Error('Pending-auth storage (the shared agent-state plane) is not configured.');
  }
  const now = deps.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const bareId = newPendingAuthId(deps.randomBytesImpl);
    const id = docId(bareId);
    const doc: PendingAuthDoc = {
      id,
      cacheScope: id,
      kind: PENDING_KIND,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      state: input.state ?? null,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      createdAt,
      expiresAt,
      attempts: 0,
      burned: false,
    };
    try {
      await deps.create(CACHE_CONTAINER, id, doc);
      return { id: bareId, expiresAt };
    } catch {
      // id collision on a fresh 128-bit random id -- retry with a new one.
    }
  }
  throw new Error('Could not create a pending authorization record.');
}

type PendingAuthLookup =
  | { ok: true; doc: PendingAuthDoc; etag: string }
  | { ok: false; reason: 'not_found_or_expired' }
  | { ok: false; reason: 'store_error' };

async function loadPendingAuth(pendingId: string, deps: OAuthConsentDeps): Promise<PendingAuthLookup> {
  if (!deps.configured()) return { ok: false, reason: 'store_error' };
  const id = docId(pendingId);
  let row: Awaited<ReturnType<typeof readDoc>>;
  try {
    row = await deps.read(CACHE_CONTAINER, id, id);
  } catch {
    return { ok: false, reason: 'store_error' };
  }
  if (!row || !row.etag || !isPendingAuthDoc(row.doc)) return { ok: false, reason: 'not_found_or_expired' };
  if (row.doc.burned) return { ok: false, reason: 'not_found_or_expired' };
  if (Date.parse(row.doc.expiresAt) <= deps.now()) return { ok: false, reason: 'not_found_or_expired' };
  return { ok: true, doc: row.doc, etag: row.etag };
}

/** Best-effort single-use cleanup. Never throws: this runs on the SUCCESS path after a code has
 *  already been decided on, so a delete hiccup must not turn a successful consent into a failure --
 *  the record simply expires naturally via its TTL check instead. */
async function deletePendingAuthBestEffort(pendingId: string, deps: OAuthConsentDeps): Promise<void> {
  try {
    const id = docId(pendingId);
    await deps.delete(CACHE_CONTAINER, id, id);
  } catch {
    /* best-effort */
  }
}

/** What GET/POST /oauth/authorize's route handlers act on. 'issue' is the ONLY outcome that leads
 *  to a code being minted + a redirect; every other outcome is a non-redirecting HTTP response. */
export type ResolveOutcome =
  | {
      outcome: 'issue';
      clientId: string;
      redirectUri: string;
      state: string | null;
      codeChallenge: string;
      codeChallengeMethod: 'S256';
      /** The elevated role, or null for the plain read-only completion. */
      agentOverride: string | null;
    }
  /** `expiresAt` is the SAME pending record's own expiry (never re-read from storage, never
   *  extended by a wrong guess) -- carried here purely so the caller can re-render renderConsentPage's
   *  "valid until" line without a second storage read. It is NOT a new expiry for this retry. */
  | { outcome: 'retry'; message: string; expiresAt: string }
  | { outcome: 'burned' }
  | { outcome: 'store_error' };

/** The explicit, code-free "connect read-only instead" choice. Always resolves to the SAME
 *  external-read outcome a code-free DCR completion gets today (agentOverride: null) -- it never
 *  reads or touches auth/setup-codes.ts at all. A lookup failure here is reported as 'store_error'
 *  (there is no meaningful "fallback" when the redirect target itself cannot be read back). */
export async function resolveReadOnlyChoice(
  pendingId: string,
  deps: OAuthConsentDeps = defaultOAuthConsentDeps,
): Promise<ResolveOutcome> {
  const found = await loadPendingAuth(pendingId, deps);
  if (!found.ok) return found.reason === 'store_error' ? { outcome: 'store_error' } : { outcome: 'burned' };
  await deletePendingAuthBestEffort(pendingId, deps);
  return {
    outcome: 'issue',
    clientId: found.doc.clientId,
    redirectUri: found.doc.redirectUri,
    state: found.doc.state,
    codeChallenge: found.doc.codeChallenge,
    codeChallengeMethod: found.doc.codeChallengeMethod,
    agentOverride: null,
  };
}

/**
 * The "elevate with owner code" choice. See this file's header for the full fail-loud contract.
 * Bounded retry (mirrors auth/setup-codes.ts's CAS loop): a concurrent submission for the SAME
 * pending_id racing this attempts-increment gets a 412 on its replace, and retries against
 * freshly-read state rather than risk two racing wrong guesses both landing as "attempt 1 of 5".
 */
export async function resolveElevateChoice(
  pendingId: string,
  rawCode: string,
  deps: OAuthConsentDeps = defaultOAuthConsentDeps,
  setupCodeDeps: SetupCodeDeps = defaultSetupCodeDeps,
): Promise<ResolveOutcome> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await loadPendingAuth(pendingId, deps);
    if (!found.ok) return found.reason === 'store_error' ? { outcome: 'store_error' } : { outcome: 'burned' };
    // Defensive redundancy, not the primary gate: `attempts` and `burned` are always written
    // together in the SAME replace call below, so loadPendingAuth's own `row.doc.burned` check
    // above already catches an already-burned record in the ordinary case. This second check is
    // the backstop for a doc that somehow reached attempts>=MAX with burned still false (a future
    // refactor that decouples the two fields, or an out-of-band manual data fix) -- it must still
    // refuse rather than grant one more guess past the budget.
    if (found.doc.attempts >= MAX_SETUP_CODE_ATTEMPTS) {
      await deletePendingAuthBestEffort(pendingId, deps);
      return { outcome: 'burned' };
    }

    const consumed = await consumeSetupCode(rawCode, setupCodeDeps);
    if (consumed.ok) {
      await deletePendingAuthBestEffort(pendingId, deps);
      return {
        outcome: 'issue',
        clientId: found.doc.clientId,
        redirectUri: found.doc.redirectUri,
        state: found.doc.state,
        codeChallenge: found.doc.codeChallenge,
        codeChallengeMethod: found.doc.codeChallengeMethod,
        agentOverride: consumed.role,
      };
    }
    if (consumed.reason === 'store_unavailable') return { outcome: 'store_error' };

    // Wrong/expired/already-used code: burn exactly one attempt, atomically.
    const nextAttempts = found.doc.attempts + 1;
    const burned = nextAttempts >= MAX_SETUP_CODE_ATTEMPTS;
    const updated: PendingAuthDoc = { ...found.doc, attempts: nextAttempts, burned };
    let result: Awaited<ReturnType<typeof replaceDoc>>;
    try {
      result = await deps.replace(CACHE_CONTAINER, docId(pendingId), docId(pendingId), updated, found.etag);
    } catch {
      // Fail LOUD: never let a storage error on the attempts-write look like a normal wrong-code
      // retry (which would silently hand the caller another guess with no budget actually spent).
      return { outcome: 'store_error' };
    }
    if (result.status === 412) continue; // lost the race -- re-read fresh state and retry
    // A 404 here means the record was deleted between our read and this write -- almost always a
    // CONCURRENT SUCCESSFUL redemption (resolveElevateChoice's success path deletes on completion;
    // resolveReadOnlyChoice's does too) racing this wrong-guess. That is not an infrastructure
    // problem, so it gets the same clean, non-alarming outcome as "not found" above, not a 500.
    if (result.status === 404) return { outcome: 'burned' };
    if (!result.ok) return { outcome: 'store_error' };
    if (burned) return { outcome: 'burned' };
    return { outcome: 'retry', message: 'That code is invalid or has expired.', expiresAt: found.doc.expiresAt };
  }
  return { outcome: 'store_error' };
}

export function buildAuthorizeRedirectUrl(redirectUri: string, code: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

// ============================ HTML rendering (pure; no IO) ============================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE = `body{font-family:system-ui,-apple-system,sans-serif;background:#f5f7fb;color:#102035;margin:0;padding:7vw}main{max-width:480px;margin:auto;background:#fff;border:1px solid #d9e0ea;border-radius:16px;padding:32px;box-shadow:0 12px 36px rgba(16,32,53,0.09)}h1{font-size:1.35rem;margin:0 0 8px}p{color:#4a5a70;line-height:1.5}label{display:block;font-weight:600;margin:20px 0 6px;font-size:.9rem}input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:9px;border:1px solid #9caabd;letter-spacing:.05em;text-transform:uppercase}.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font:inherit;padding:12px;border-radius:9px;border:0;cursor:pointer;font-weight:650}.primary{background:#0b5fff;color:#fff}.secondary{background:#eef1f6;color:#102035}.err{color:#b42318;background:#fdecea;border:1px solid #f7c8c2;border-radius:9px;padding:10px 12px;margin:16px 0 0;font-size:.9rem}.hint{color:#7c8aa0;font-size:.8rem;margin-top:10px}`;

/** Pure formatting helper: turn a pending record's `expiresAt` (an ISO string this file itself
 *  produced, either freshly in createPendingAuth or read back unmodified in resolveElevateChoice's
 *  'retry' outcome) into the exact "HH:MM UTC" text shown on the consent page -- 24-hour, zero-padded,
 *  always UTC so the printed time never depends on the reader's or the server's local timezone. Falls
 *  back to a neutral, non-alarming phrase rather than ever rendering "NaN:NaN UTC" if a future caller
 *  somehow passes something unparsable; this should never happen in practice since both call sites
 *  pass a value this file generated, not anything client-supplied. */
export function formatValidUntilUtc(expiresAt: string): string {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return 'shortly';
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/** The consent form. No dynamic content is ever interpolated except the pending_id (server-
 *  generated hex, never attacker-influenced), the optional retry error (a fixed, non-secret literal
 *  this file itself chooses -- see resolveElevateChoice's 'retry' message), and the pending record's
 *  own `expiresAt` (also server-computed, also never attacker-influenced) -- all three are still run
 *  through escapeHtml as a blanket, no-exceptions practice. `expiresAt` is a REQUIRED parameter, not
 *  optional: both call sites in oauth.ts already have it on hand (createPendingAuth's own return, or
 *  the stored record's own expiresAt threaded through the 'retry' outcome) without a second storage
 *  read, and making it required means a future call site that forgets to thread it through fails to
 *  compile rather than silently rendering a page with no "valid until" line. Deliberately NEVER
 *  renders client_id/redirect_uri: those come from the DCR client's own self-registration and, absent
 *  an OAUTH_REDIRECT_URIS allow-list, can be an attacker-chosen https URL -- rendering it here would
 *  need the SAME escaping discipline for no user benefit, so the simplest defense is to never
 *  interpolate it into the page at all. */
export function renderConsentPage(pendingId: string, errorMessage: string | undefined, expiresAt: string): string {
  const errorBlock = errorMessage ? `<p class="err">${escapeHtml(errorMessage)}</p>` : '';
  const validUntilBlock = `<p class="hint">This page is valid until ${escapeHtml(formatValidUntilUtc(expiresAt))}.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OTCHealth Gateway Connection</title><style>${PAGE_STYLE}</style></head><body><main><h1>Connect to the OTCHealth gateway</h1><p>A connector is requesting access to the OTCHealth gateway.</p>${errorBlock}<form method="post" action="/oauth/authorize/consent"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><label for="code">Owner setup code (optional)</label><input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" maxlength="64"><p class="hint">Have a setup code from the OTCHealth CTO? Enter it to connect with an elevated role. Otherwise, connect read-only.</p>${validUntilBlock}<div class="row"><button type="submit" name="action" value="readonly" class="secondary">Connect read-only instead</button><button type="submit" name="action" value="elevate" class="primary">Elevate with owner code</button></div></form></main></body></html>`;
}

/** A dead-end page: no form, nothing left to submit. `kind` distinguishes a clean expiry/tamper
 *  (400) from a genuine server error (500) purely in wording -- oauth.ts picks the status code.
 *  The 'expired' copy is deliberately explicit that THIS PAGE itself is spent and a fresh code cannot
 *  revive it -- the prior wording ("Return to the app... and try again") read as generic enough that
 *  users repeatedly fetched a brand-new setup code and pasted it into this same dead page, which can
 *  never work: a NEW /oauth/authorize GET (clicking Authenticate again in the app) is required to get
 *  a live pending record. */
export function renderDeadEndPage(kind: 'expired' | 'server_error'): string {
  const title = kind === 'expired' ? 'This connection request has expired' : 'Something went wrong';
  const message =
    kind === 'expired'
      ? 'This connection request has expired or was already used. Go back to the app you were connecting, click Authenticate again, and enter your setup code on the new page that opens. A code will not work on this page.'
      : 'Please try again in a moment. If this keeps happening, contact the OTCHealth team.';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OTCHealth Gateway Connection</title><style>${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

export function applyConsentPageHeaders(reply: FastifyReply): void {
  reply.header(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  reply.header('cache-control', 'no-store');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.type('text/html; charset=utf-8');
}
