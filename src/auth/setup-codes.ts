/**
 * Owner-held setup codes: the credential that lets the OAuth consent interstitial
 * (server/oauth-consent.ts, wired into server/oauth.ts's GET /oauth/authorize) elevate a
 * self-registered public (DCR) connector client to a privileged agent lane, WITHOUT the connector
 * ever holding a client secret. See docs/CHATGPT-CONNECT.md for the end-to-end flow.
 *
 * ============================ WHY THIS IS SAFE (the July P0's lesson, applied) ============================
 * The July 2026 P0 (see server/oauth.ts's Part 6 comment) happened because a privileged lane was
 * derived from something the CLIENT supplied at self-registration (its chosen client_name) -- no
 * owner-held secret was ever checked. The fix removed that inference entirely: every public DCR
 * client is now hard-bound to 'external-read' at /register, unconditionally.
 *
 * Elevation here does NOT reopen that hole, because the thing that determines the granted role is
 * never client-supplied. A setup code:
 *   - is MINTED only by a caller already holding a cto/exec gateway credential (governance.ts +
 *     an in-handler check in tools/oauth/setup-code-create.ts), for EXACTLY ONE role fixed at mint
 *     time (never a range, never "whatever the redeemer asks for");
 *   - is a high-entropy (80-bit) random value the client never sees until the OWNER (a human who
 *     already trusts the caller that minted it) types it into the consent page in THEIR OWN
 *     browser -- the connector process itself never has it, so a malicious connector cannot smuggle
 *     one in via any field it controls (client_name, redirect_uri, a query param, ...);
 *   - is looked up by its own SHA-256 hash as the document's id/partition key (never compared
 *     against a caller-supplied "which role do you want" field), single-use, and TTL-bounded.
 * So the two inputs that jointly decide the outcome -- "does this exact code exist, unused,
 * unexpired" and "what role was it minted for" -- are both resolved ENTIRELY server-side from
 * durable storage this module owns. Nothing the client supplies (client_id, client_name,
 * redirect_uri, or the code text itself, if wrong) can select a role; a wrong/unknown code just
 * fails, and a right one yields only the one role fixed when an already-privileged caller minted it.
 *
 * ============================ STORAGE ============================
 * Reuses the SAME shared `cache` container every other short-lived, single-use gateway credential
 * already lives in (see tools/heygen/broker.ts's HeyGen pairing docs, auth/revocation-store.ts's
 * revoked-token docs) -- multi-replica-safe by construction, because it goes through
 * agentstate/store.ts (the STATE_BACKEND dispatcher: Postgres in production, Cosmos previously),
 * never a concrete backend directly (agentstate-dependency-guard.test.ts enforces this repo-wide).
 * One doc per code, id = pk = `connector-setup-code_<sha256-hex>`, so a lookup is a single indexed
 * point-read/write, not a scan -- and the id ALREADY encodes the hash, so an unknown code and a
 * wrong-guess collapse into the identical "no such row" outcome by construction, before any
 * comparison logic runs at all. Single-use consumption is an ETag compare-and-swap
 * (agentstate/store.ts's replaceDoc(ifMatch)), the exact pattern claimHeyGenPairing/
 * finishHeyGenPairing and agentstate/ledger.ts's claim/heartbeat/complete already use: read the
 * current doc + etag, mutate, replace conditioned on that etag, and treat a 412 (someone else
 * replaced it first) as "lost the race" rather than a real error. That is what makes two replicas
 * racing to consume the SAME code resolve to exactly one success, not zero and not two.
 *
 * All storage access is dependency-injected (SetupCodeDeps) so the CAS race itself is unit-testable
 * with a small in-memory fake store carrying REAL ETag semantics, mirroring
 * tools/heygen/broker.test.ts's fakeHeyGenDeps() convention, rather than requiring a live database
 * in this repo's hermetic test suite.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createDoc,
  isConfigured as agentStateConfigured,
  readDoc,
  replaceDoc,
} from '../agentstate/store.js';

const CACHE_CONTAINER = 'cache';
const SETUP_CODE_KIND = 'connector-setup-code';
const DOC_ID_PREFIX = 'connector-setup-code_';

/**
 * The ONLY roles a setup code may ever be minted for. `clo-personal` -- the attorney-privileged,
 * California-family-matter ring (see tools/kb/search-privileged.ts's PERSONAL_LEGAL_RING) -- is
 * deliberately, permanently absent: it has no connector-elevation path of any kind, ever. This is
 * enforced twice: assertMintableRole() below refuses to mint it (and refuses anything not in this
 * list), and isSetupCodeDoc()'s shape check refuses to even RECOGNIZE a stored doc whose role is
 * not one of these six -- so a future bug that somehow got a bad role into storage still could not
 * be redeemed for it.
 */
export const ELEVATION_ROLES = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer'] as const;
export type ElevationRole = (typeof ELEVATION_ROLES)[number];

export function isElevationRole(value: string): value is ElevationRole {
  return (ELEVATION_ROLES as readonly string[]).includes(value);
}

export class SetupCodeError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SetupCodeError';
    this.code = code;
  }
}

/** Throws SetupCodeError('role_not_mintable', ...) for clo-personal or anything outside
 *  ELEVATION_ROLES. `clo-personal` gets its own named branch so the refusal message is unambiguous
 *  rather than reading as "just another typo". */
export function assertMintableRole(role: string): asserts role is ElevationRole {
  if (role === 'clo-personal') {
    throw new SetupCodeError(
      'role_not_mintable',
      'clo-personal can never be granted through a connector setup code. It has no elevation path, ever.',
    );
  }
  if (!isElevationRole(role)) {
    throw new SetupCodeError(
      'role_not_mintable',
      `"${role}" is not an elevation-eligible role. Allowed: ${ELEVATION_ROLES.join(', ')}.`,
    );
  }
}

// Crockford base32: digits 0-9 plus the letters minus I, L, O, U (the confusable ones). EXACTLY 32
// symbols -- the previous alphabet here claimed 32 but actually contained 31 (caught by CodeQL
// js/biased-cryptographic-random on this PR: `byte % 31` IS modulo-biased, since 256 % 31 !== 0).
// With a true power-of-two alphabet, `byte & 31` is an exactly uniform pick per byte with no
// modulo at all -- 16 bytes -> 16 symbols * 5 bits = a real 80 bits of entropy, grouped for
// readability as four four-character blocks. Generated codes never contain I/L/O/U; a human who
// MISREADS one back (O for 0, I or L for 1) is silently corrected by normalizeSetupCode below,
// which is Crockford's own decode rule.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_SYMBOLS = 16;

export function generateSetupCodePlaintext(randomBytesImpl: (size: number) => Buffer = randomBytes): string {
  const bytes = randomBytesImpl(CODE_SYMBOLS);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

/** Normalize a user-typed code before hashing: uppercase, drop everything that is not [A-Z0-9]
 *  (hyphens, spaces, stray punctuation a phone keyboard/autocorrect might add), then apply
 *  Crockford base32's confusion mapping (O -> 0, I/L -> 1) so a human who misread an ambiguous
 *  glyph still types a code that hashes identically. Generated codes never contain I/L/O/U, so
 *  for a correctly-copied code the mapping is a no-op. */
export function normalizeSetupCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function hashSetupCode(normalizedCode: string): string {
  return createHash('sha256').update(normalizedCode).digest('hex');
}

function docIdForHash(hash: string): string {
  return `${DOC_ID_PREFIX}${hash}`;
}

function constantTimeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface SetupCodeDoc extends Record<string, unknown> {
  id: string;
  cacheScope: string;
  kind: typeof SETUP_CODE_KIND;
  codeHash: string;
  role: ElevationRole;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  usedAt: string | null;
}

function isSetupCodeDoc(value: unknown): value is SetupCodeDoc {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<SetupCodeDoc>;
  return (
    typeof d.id === 'string' &&
    d.cacheScope === d.id &&
    d.kind === SETUP_CODE_KIND &&
    typeof d.codeHash === 'string' &&
    /^[a-f0-9]{64}$/.test(d.codeHash) &&
    typeof d.role === 'string' &&
    isElevationRole(d.role) &&
    typeof d.createdAt === 'string' &&
    typeof d.expiresAt === 'string' &&
    Number.isFinite(Date.parse(d.expiresAt)) &&
    typeof d.createdBy === 'string' &&
    (d.usedAt === null || typeof d.usedAt === 'string')
  );
}

// Exported so server/oauth-consent.ts can derive the consent interstitial's own pending-auth TTL
// from this single number instead of hardcoding a second one that can silently drift out of
// lockstep with it (see that file's PENDING_TTL_MS comment for why a shorter pending-auth clock
// than the code's own default TTL is a real, user-visible dead-end bug, not a theoretical one).
export const DEFAULT_TTL_MINUTES = 30;
const MIN_TTL_MINUTES = 1;
const MAX_TTL_MINUTES = 24 * 60; // 24h, per the brief's stated bound

export function clampTtlMinutes(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.round(requested)));
}

export interface SetupCodeDeps {
  now: () => number;
  randomBytesImpl: (size: number) => Buffer;
  create: typeof createDoc;
  read: typeof readDoc;
  replace: typeof replaceDoc;
  configured: () => boolean;
}

export const defaultSetupCodeDeps: SetupCodeDeps = {
  now: () => Date.now(),
  randomBytesImpl: randomBytes,
  create: createDoc,
  read: readDoc,
  replace: replaceDoc,
  configured: agentStateConfigured,
};

export interface MintSetupCodeInput {
  role: string;
  createdBy: string;
  label?: string | null;
  ttlMinutes?: number;
}

export interface MintedSetupCode {
  code: string;
  role: ElevationRole;
  expiresAt: string;
  ttlMinutes: number;
}

/**
 * Mint a new owner-held setup code for exactly one role. Throws SetupCodeError('role_not_mintable')
 * for clo-personal / anything outside ELEVATION_ROLES (checked BEFORE any storage access), and
 * SetupCodeError('setup_code_store_unavailable') if the shared agent-state plane is not configured
 * or a doc could not be created after bounded retries (an astronomically-improbable hash collision
 * on a fresh 80-bit random code is the only expected retry cause).
 */
export async function mintSetupCode(
  input: MintSetupCodeInput,
  deps: SetupCodeDeps = defaultSetupCodeDeps,
): Promise<MintedSetupCode> {
  assertMintableRole(input.role);
  if (!deps.configured()) {
    throw new SetupCodeError(
      'setup_code_store_unavailable',
      'Setup-code storage (the shared agent-state plane) is not configured.',
    );
  }
  const ttlMinutes = clampTtlMinutes(input.ttlMinutes);
  const now = deps.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
  const label = input.label && input.label.trim() ? input.label.trim().slice(0, 200) : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateSetupCodePlaintext(deps.randomBytesImpl);
    const codeHash = hashSetupCode(normalizeSetupCode(code));
    const id = docIdForHash(codeHash);
    const doc: SetupCodeDoc = {
      id,
      cacheScope: id,
      kind: SETUP_CODE_KIND,
      codeHash,
      role: input.role,
      label,
      createdAt,
      expiresAt,
      createdBy: input.createdBy,
      usedAt: null,
    };
    try {
      await deps.create(CACHE_CONTAINER, id, doc);
      return { code, role: input.role, expiresAt, ttlMinutes };
    } catch {
      // A hash collision on a fresh random 80-bit code is cryptographically near-impossible; retry
      // with a freshly generated code rather than surfacing a spurious failure.
    }
  }
  throw new SetupCodeError('setup_code_store_unavailable', 'Could not create a setup code.');
}

export type SetupCodeConsumeResult =
  | { ok: true; role: ElevationRole }
  | { ok: false; reason: 'invalid_or_expired' }
  | { ok: false; reason: 'store_unavailable' };

/**
 * Atomically validate + single-use-consume a submitted setup code.
 *
 * HOSTILE-REVIEWER INVARIANT: nothing the caller supplies here can select a role. The ONLY inputs
 * are the code TEXT (hashed and looked up by that hash as the doc id -- an unknown code and a
 * wrong-guess are indistinguishable by construction) and the deps (never caller-influenced). On
 * success the ONLY output is the role the code was minted for; there is no parameter through which
 * a caller could ask for a different one.
 *
 * MULTI-REPLICA RACE: the read -> mutate -> replace(ifMatch) -> retry-on-412 loop below is the same
 * shape as tools/heygen/broker.ts's claimHeyGenPairing and agentstate/ledger.ts's claimTask. If two
 * replicas race to consume the SAME code, at most one replace can win with the etag it read; the
 * other gets status 412, loops, re-reads the NOW-used doc, and returns {ok:false} -- so exactly one
 * caller ever observes {ok:true} for a given code, never zero (barring genuine store failure, which
 * is its own distinct {ok:false, reason:'store_unavailable'} outcome) and never two.
 */
export async function consumeSetupCode(
  rawCode: string,
  deps: SetupCodeDeps = defaultSetupCodeDeps,
): Promise<SetupCodeConsumeResult> {
  if (!deps.configured()) return { ok: false, reason: 'store_unavailable' };
  const normalized = normalizeSetupCode(rawCode || '');
  if (!normalized) return { ok: false, reason: 'invalid_or_expired' };
  const hash = hashSetupCode(normalized);
  const id = docIdForHash(hash);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let row: Awaited<ReturnType<typeof readDoc>>;
    try {
      row = await deps.read(CACHE_CONTAINER, id, id);
    } catch {
      return { ok: false, reason: 'store_unavailable' };
    }
    if (!row || !row.etag || !isSetupCodeDoc(row.doc)) return { ok: false, reason: 'invalid_or_expired' };
    const doc = row.doc;

    // Defense-in-depth constant-time re-comparison of the hash the id already encodes. A mismatch
    // here would mean the id/codeHash pair was written inconsistently -- not that this comparison
    // is what makes an unknown code fail (the id-keyed point-read above already guarantees that).
    if (!constantTimeHashEqual(doc.codeHash, hash)) return { ok: false, reason: 'invalid_or_expired' };
    if (doc.usedAt !== null) return { ok: false, reason: 'invalid_or_expired' };
    if (Date.parse(doc.expiresAt) <= deps.now()) return { ok: false, reason: 'invalid_or_expired' };

    const updated: SetupCodeDoc = { ...doc, usedAt: new Date(deps.now()).toISOString() };
    let result: Awaited<ReturnType<typeof replaceDoc>>;
    try {
      result = await deps.replace(CACHE_CONTAINER, id, id, updated, row.etag);
    } catch {
      return { ok: false, reason: 'store_unavailable' };
    }
    if (result.status === 412) continue; // lost the race to a concurrent consumer -- re-read fresh state
    if (!result.ok) return { ok: false, reason: 'store_unavailable' };
    return { ok: true, role: doc.role };
  }
  // Exhausted retries under heavy contention: refuse rather than risk a double-grant.
  return { ok: false, reason: 'store_unavailable' };
}
