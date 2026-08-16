/**
 * Durable, least-privilege HeyGen OAuth token broker.
 *
 * Credential material is accepted only by POST /heygen/pair, encrypted with AES-256-GCM, and
 * persisted in the Cosmos `cache` container with ttl:-1. The access/refresh chain never appears in
 * tool output, logs, Cosmos plaintext metadata, or upstream error messages. Refreshes are serialized
 * within a replica by a promise mutex and across replicas by Cosmos ETags; a rotated chain is always
 * persisted before its access token can be returned.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';
import {
  buildHeyGenAvatarVideoPlan,
  findHeyGenFamilyStoryFounderByGroupId,
  HEYGEN_FAMILY_STORY_PROFILES,
  isHeyGenConsentAccepted,
  isHeyGenConsentStatusReady,
  parseHeyGenAvatarGroup,
  parseHeyGenAvatarLook,
  parseHeyGenBreakSeconds,
  parseHeyGenCreateVideo,
  parseHeyGenVideoDetail,
  parseHeyGenVoice,
  validateHeyGenAvatarVideoCompatibility,
  type HeyGenAvatarGroup,
  type HeyGenAvatarLook,
  type HeyGenAvatarVideoCreateInput,
  type HeyGenAvatarVideoPlan,
  type HeyGenVideoDetail,
  type HeyGenVoice,
} from './video-contracts.js';
import { loadEnv } from '../../config/env.js';
import { parseHeyGenBillingSnapshot } from './look-contracts.js';
import {
  consumeHeyGenOwnerApproval,
  verifyHeyGenAvatarVideoApproval,
} from './owner-approval.js';
import {
  reserveHeyGenSpend,
  settleHeyGenSpend,
  type HeyGenSpendReservation,
} from './spend-controller.js';
import {
  createDoc,
  isConfigured as cosmosConfigured,
  readDoc,
  replaceDoc,
} from '../../agentstate/store.js';

// Verified against the official heygen-cli source at commit
// 7a698ba72e828a233df87bd9526f343fa1b3ee29 (oauth/oauth.go, client/client.go, gen/*.go).
export const HEYGEN_OAUTH_CLIENT_ID = 'q2A2QRSke2LrFTPJhoDbHtXh';
export const HEYGEN_TOKEN_URL = 'https://api2.heygen.com/v1/oauth/token';
export const HEYGEN_API_BASE = 'https://api.heygen.com';
export const HEYGEN_TOKEN_DOC_ID = 'svc-token.heygen.primary';
export const HEYGEN_PAIR_TTL_SECONDS = 15 * 60;
export const HEYGEN_REFRESH_MARGIN_MS = 90_000;
export const HEYGEN_HKDF_INFO = 'otchealth.heygen.token-broker.v1';

const HEYGEN_HKDF_SALT = 'otchealth.gateway.oauth-token-signing-secret.hkdf-salt.v1';
const HEYGEN_ENCRYPTION_AAD = `${HEYGEN_TOKEN_DOC_ID}:v1`;
const CACHE_CONTAINER = 'cache';
const FETCH_TIMEOUT_MS = 15_000;
const TOKEN_CIPHER_VERSION = 1 as const;
const MAX_CREDENTIAL_HEADER_CHARS = 64 * 1024;
export const HEYGEN_SAFE_ID_RE = /^[A-Za-z0-9_-]{1,255}$/;
export const HEYGEN_LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?(?:-(?:[A-Za-z0-9]{5,8}|\d[A-Za-z0-9]{3}))*$/;

export type CosmosRead = typeof readDoc;
export type CosmosCreate = typeof createDoc;
export type CosmosReplace = typeof replaceDoc;

export interface HeyGenBrokerDeps {
  fetchImpl: typeof fetch;
  read: CosmosRead;
  create: CosmosCreate;
  replace: CosmosReplace;
  now: () => number;
  randomBytes: (size: number) => Buffer;
  signingSecret: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export const defaultHeyGenBrokerDeps: HeyGenBrokerDeps = {
  fetchImpl: fetch,
  read: readDoc,
  create: createDoc,
  replace: replaceDoc,
  now: Date.now,
  randomBytes,
  signingSecret: () => loadEnv().OAUTH_TOKEN_SIGNING_SECRET,
};

export class HeyGenBrokerError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 503) {
    super(message);
    this.name = 'HeyGenBrokerError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function brokerError(code: string, message: string, httpStatus = 503): HeyGenBrokerError {
  return new HeyGenBrokerError(code, message, httpStatus);
}

/** Public configuration predicate used by tools/status surfaces. */
export function heyGenBrokerConfigured(deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps): boolean {
  return Boolean(deps.signingSecret()) && (deps !== defaultHeyGenBrokerDeps || cosmosConfigured());
}

export function requireHeyGenSigningSecret(deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps): string {
  const secret = deps.signingSecret();
  if (!secret) {
    throw brokerError(
      'heygen_signing_secret_missing',
      'HeyGen token broker is unavailable because OAUTH_TOKEN_SIGNING_SECRET is not configured.',
    );
  }
  return secret;
}

// -------------------------------------------------------------------------------------------------
// Official credentials parsing
// -------------------------------------------------------------------------------------------------

const headerSafeToken = z
  .string()
  .min(1)
  .max(32 * 1024)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'token contains control characters');

const OfficialOAuthSchema = z
  .object({
    access_token: headerSafeToken,
    refresh_token: headerSafeToken,
    expires_at: z.string().datetime({ offset: true }).optional(),
    scope: z.string().max(4096).optional(),
    token_type: z.string().max(128).optional(),
  })
  .strict();

const OfficialUserSchema = z
  .object({
    email: z.string().max(512).optional(),
    first_name: z.string().max(512).optional(),
    last_name: z.string().max(512).optional(),
    username: z.string().max(512).optional(),
  })
  .strict();

const OfficialCredentialsSchema = z
  .object({
    oauth: OfficialOAuthSchema,
    // The official CLI saves this friendly-display block after /v3/users/me. It is accepted so an
    // untouched ~/.heygen/credentials file can pair, then deliberately discarded below — identity
    // metadata never enters the encrypted token state or Cosmos document.
    user: OfficialUserSchema.optional(),
  })
  .strict();

export interface HeyGenTokenState {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. Zero means the upstream credentials supplied no expiry information. */
  expiresAt: number;
  scope: string;
  tokenType: string;
}

/** Recursively reject API-key credentials even if hidden under an unexpected nested field. */
export function containsApiKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsApiKey(item));
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === 'api_key') return true;
    if (containsApiKey(child)) return true;
  }
  return false;
}

function decodeStrictBase64(encoded: string): Buffer {
  if (
    !encoded ||
    encoded.length > MAX_CREDENTIAL_HEADER_CHARS ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw brokerError('invalid_credentials', 'HeyGen OAuth credentials header is invalid.', 400);
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== encoded) {
    throw brokerError('invalid_credentials', 'HeyGen OAuth credentials header is invalid.', 400);
  }
  return decoded;
}

/** Parse the exact official credentials JSON shape; never includes the credential in an error. */
export function parseOfficialCredentialsHeader(encoded: string): HeyGenTokenState {
  let raw: unknown;
  try {
    raw = JSON.parse(decodeStrictBase64(encoded).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof HeyGenBrokerError) throw error;
    throw brokerError('invalid_credentials', 'HeyGen OAuth credentials header is invalid.', 400);
  }
  if (containsApiKey(raw)) {
    throw brokerError('api_key_forbidden', 'API-key credentials are not accepted by the HeyGen OAuth token broker.', 400);
  }
  const parsed = OfficialCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw brokerError('invalid_credentials', 'HeyGen OAuth credentials must use the official OAuth credentials schema.', 400);
  }
  const expiresAt = parsed.data.oauth.expires_at ? Date.parse(parsed.data.oauth.expires_at) : 0;
  return {
    accessToken: parsed.data.oauth.access_token,
    refreshToken: parsed.data.oauth.refresh_token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    scope: parsed.data.oauth.scope ?? '',
    tokenType: parsed.data.oauth.token_type ?? 'Bearer',
  };
}

// -------------------------------------------------------------------------------------------------
// AES-256-GCM envelope
// -------------------------------------------------------------------------------------------------

export interface HeyGenEncryptedTokenState {
  version: typeof TOKEN_CIPHER_VERSION;
  ciphertext: string;
  iv: string;
  tag: string;
}

export function deriveHeyGenEncryptionKey(signingSecret: string): Buffer {
  if (!signingSecret) {
    throw brokerError(
      'heygen_signing_secret_missing',
      'HeyGen token broker is unavailable because OAUTH_TOKEN_SIGNING_SECRET is not configured.',
    );
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(signingSecret, 'utf8'),
      Buffer.from(HEYGEN_HKDF_SALT, 'utf8'),
      Buffer.from(HEYGEN_HKDF_INFO, 'utf8'),
      32,
    ),
  );
}

export function encryptHeyGenTokenState(
  state: HeyGenTokenState,
  signingSecret: string,
  randomBytesImpl: (size: number) => Buffer = randomBytes,
): HeyGenEncryptedTokenState {
  const key = deriveHeyGenEncryptionKey(signingSecret);
  const iv = randomBytesImpl(12);
  if (iv.length !== 12) throw brokerError('encryption_failed', 'HeyGen token encryption failed.');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(HEYGEN_ENCRYPTION_AAD, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: TOKEN_CIPHER_VERSION,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptHeyGenTokenState(
  encrypted: HeyGenEncryptedTokenState,
  signingSecret: string,
): HeyGenTokenState {
  if (encrypted.version !== TOKEN_CIPHER_VERSION) {
    throw brokerError('token_state_invalid', 'Stored HeyGen token state uses an unsupported encryption version.');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveHeyGenEncryptionKey(signingSecret),
      Buffer.from(encrypted.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(HEYGEN_ENCRYPTION_AAD, 'utf8'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
    const state = z
      .object({
        accessToken: headerSafeToken,
        refreshToken: headerSafeToken,
        expiresAt: z.number().finite().nonnegative(),
        scope: z.string(),
        tokenType: z.string(),
      })
      .strict()
      .safeParse(decoded);
    if (!state.success) throw new Error('invalid token state');
    return state.data;
  } catch {
    throw brokerError('token_state_decryption_failed', 'Stored HeyGen token state could not be decrypted.');
  }
}

// -------------------------------------------------------------------------------------------------
// Cosmos documents and pairing lifecycle
// -------------------------------------------------------------------------------------------------

export type HeyGenPairingStatus = 'unused' | 'claiming' | 'used' | 'failed';

export interface HeyGenPairingDoc extends Record<string, unknown> {
  id: string;
  cacheScope: string;
  ttl: number;
  kind: 'heygen_pairing';
  status: HeyGenPairingStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt?: string;
  completedAt?: string;
  failureCode?: string;
}

export interface HeyGenTokenDoc extends Record<string, unknown>, HeyGenEncryptedTokenState {
  id: typeof HEYGEN_TOKEN_DOC_ID;
  cacheScope: typeof HEYGEN_TOKEN_DOC_ID;
  ttl: -1;
  kind: 'heygen_oauth_token';
  status: 'live';
  familyFingerprint: string;
  pairedAt: string;
  updatedAt: string;
}

export function newHeyGenPairId(randomBytesImpl: (size: number) => Buffer = randomBytes): string {
  const bytes = randomBytesImpl(32);
  if (bytes.length !== 32) throw brokerError('pairing_entropy_failed', 'Could not create a HeyGen pairing id.');
  return bytes.toString('base64url');
}

export function buildHeyGenPairingDoc(pairId: string, nowMs = Date.now()): HeyGenPairingDoc {
  const now = new Date(nowMs);
  return {
    id: pairId,
    cacheScope: pairId,
    ttl: HEYGEN_PAIR_TTL_SECONDS,
    kind: 'heygen_pairing',
    status: 'unused',
    createdAt: now.toISOString(),
    expiresAt: new Date(nowMs + HEYGEN_PAIR_TTL_SECONDS * 1000).toISOString(),
  };
}

export function newHeyGenTokenFamilyFingerprint(
  randomBytesImpl: (size: number) => Buffer = randomBytes,
): string {
  // A random family id is enough to correlate concurrent refreshes from the SAME pairing. It does
  // not need to be derived from OAuth material at all; avoiding a token hash removes an unnecessary
  // secret-derived value from plaintext metadata and prevents this identifier from being mistaken
  // for password hashing by security scanners.
  const bytes = randomBytesImpl(16);
  if (bytes.length !== 16) throw brokerError('pairing_entropy_failed', 'Could not create a HeyGen token family id.');
  return bytes.toString('hex');
}

function assertSubscriptionAccount(userResponse: unknown): void {
  const data = (userResponse as { data?: Record<string, unknown> } | null)?.data;
  const subscription = data?.subscription;
  const populated =
    subscription !== null &&
    typeof subscription === 'object' &&
    !Array.isArray(subscription) &&
    Object.keys(subscription as Record<string, unknown>).length > 0;
  if (data?.billing_type !== 'subscription' || !populated) {
    throw brokerError(
      'subscription_required',
      'HeyGen access is restricted to an active subscription account.',
      403,
    );
  }
}

export function buildHeyGenTokenDoc(input: {
  state: HeyGenTokenState;
  signingSecret: string;
  userResponse: unknown;
  nowMs?: number;
  pairedAt?: string;
  familyFingerprint?: string;
  randomBytesImpl?: (size: number) => Buffer;
}): HeyGenTokenDoc {
  const nowMs = input.nowMs ?? Date.now();
  const encrypted = encryptHeyGenTokenState(
    input.state,
    input.signingSecret,
    input.randomBytesImpl ?? randomBytes,
  );
  // Validation-only: do not persist account/user response fields. The token document is deliberately
  // limited to the encrypted envelope plus durability/family/live metadata.
  assertSubscriptionAccount(input.userResponse);
  return {
    id: HEYGEN_TOKEN_DOC_ID,
    cacheScope: HEYGEN_TOKEN_DOC_ID,
    ttl: -1,
    kind: 'heygen_oauth_token',
    status: 'live',
    familyFingerprint: input.familyFingerprint ?? newHeyGenTokenFamilyFingerprint(input.randomBytesImpl ?? randomBytes),
    pairedAt: input.pairedAt ?? new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    ...encrypted,
  };
}

function isPairingDoc(value: unknown): value is HeyGenPairingDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<HeyGenPairingDoc>;
  return (
    typeof doc.id === 'string' &&
    doc.cacheScope === doc.id &&
    doc.ttl === HEYGEN_PAIR_TTL_SECONDS &&
    doc.kind === 'heygen_pairing' &&
    ['unused', 'claiming', 'used', 'failed'].includes(String(doc.status)) &&
    typeof doc.createdAt === 'string' &&
    typeof doc.expiresAt === 'string' &&
    Number.isFinite(Date.parse(doc.expiresAt))
  );
}

function encryptedStateFromDoc(doc: HeyGenTokenDoc): HeyGenEncryptedTokenState {
  return {
    version: doc.version,
    ciphertext: doc.ciphertext,
    iv: doc.iv,
    tag: doc.tag,
  };
}

function isTokenDoc(value: unknown): value is HeyGenTokenDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<HeyGenTokenDoc>;
  return (
    doc.id === HEYGEN_TOKEN_DOC_ID &&
    doc.cacheScope === HEYGEN_TOKEN_DOC_ID &&
    doc.ttl === -1 &&
    doc.kind === 'heygen_oauth_token' &&
    doc.status === 'live' &&
    doc.version === TOKEN_CIPHER_VERSION &&
    typeof doc.ciphertext === 'string' &&
    typeof doc.iv === 'string' &&
    typeof doc.tag === 'string' &&
    typeof doc.familyFingerprint === 'string' &&
    /^[a-f0-9]{32}$/.test(doc.familyFingerprint) &&
    typeof doc.pairedAt === 'string' &&
    typeof doc.updatedAt === 'string'
  );
}

export async function startHeyGenPairing(
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenPairingDoc> {
  requireHeyGenSigningSecret(deps);
  if (deps === defaultHeyGenBrokerDeps && !cosmosConfigured()) {
    throw brokerError('heygen_store_unavailable', 'HeyGen token broker storage is not configured.');
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pairId = newHeyGenPairId(deps.randomBytes);
    const doc = buildHeyGenPairingDoc(pairId, deps.now());
    try {
      await deps.create(CACHE_CONTAINER, pairId, doc);
      return doc;
    } catch {
      // A cryptographically improbable id collision is safe to retry. Any persistent store failure is
      // collapsed to the same sanitized result after the bounded attempts.
    }
  }
  throw brokerError('heygen_store_unavailable', 'Could not create a HeyGen pairing session.');
}

export interface HeyGenPairingStatusView {
  pairId: string;
  status: HeyGenPairingStatus | 'expired' | 'missing';
  expiresAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
}

export async function getHeyGenPairingStatus(
  pairId: string,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenPairingStatusView> {
  let row: Awaited<ReturnType<CosmosRead>>;
  try {
    row = await deps.read(CACHE_CONTAINER, pairId, pairId);
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not read the HeyGen pairing session.');
  }
  if (!row || !isPairingDoc(row.doc)) {
    return { pairId, status: 'missing', expiresAt: null, completedAt: null, failureCode: null };
  }
  const expired = row.doc.status === 'unused' && Date.parse(row.doc.expiresAt) <= deps.now();
  return {
    pairId,
    status: expired ? 'expired' : row.doc.status,
    expiresAt: row.doc.expiresAt,
    completedAt: row.doc.completedAt ?? null,
    failureCode: row.doc.failureCode ?? null,
  };
}

export interface ClaimedHeyGenPairing {
  doc: HeyGenPairingDoc;
  etag: string;
}

/** Atomically consume an unused pair by ETag-replacing it with status=claiming. */
export async function claimHeyGenPairing(
  pairId: string,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<ClaimedHeyGenPairing> {
  let row: Awaited<ReturnType<CosmosRead>>;
  try {
    row = await deps.read(CACHE_CONTAINER, pairId, pairId);
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not claim the HeyGen pairing session.');
  }
  if (!row || !row.etag || !isPairingDoc(row.doc)) {
    throw brokerError('pair_unavailable', 'HeyGen pairing id is missing, expired, or already used.', 409);
  }
  if (row.doc.status !== 'unused' || Date.parse(row.doc.expiresAt) <= deps.now()) {
    throw brokerError('pair_unavailable', 'HeyGen pairing id is missing, expired, or already used.', 409);
  }
  const claiming: HeyGenPairingDoc = {
    ...row.doc,
    status: 'claiming',
    claimedAt: new Date(deps.now()).toISOString(),
  };
  let result: Awaited<ReturnType<CosmosReplace>>;
  try {
    result = await deps.replace(CACHE_CONTAINER, pairId, pairId, claiming, row.etag);
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not claim the HeyGen pairing session.');
  }
  if (result.status === 412) {
    throw brokerError('pair_unavailable', 'HeyGen pairing id is missing, expired, or already used.', 409);
  }
  if (!result.ok || !result.etag) {
    throw brokerError('heygen_store_unavailable', 'Could not claim the HeyGen pairing session.');
  }
  return { doc: claiming, etag: result.etag };
}

export async function finishHeyGenPairing(
  claim: ClaimedHeyGenPairing,
  status: 'used' | 'failed',
  failureCode: string | undefined,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<void> {
  const finished: HeyGenPairingDoc = {
    ...claim.doc,
    status,
    completedAt: new Date(deps.now()).toISOString(),
  };
  if (failureCode) finished.failureCode = failureCode;
  let result: Awaited<ReturnType<CosmosReplace>>;
  try {
    result = await deps.replace(
      CACHE_CONTAINER,
      claim.doc.id,
      claim.doc.id,
      finished,
      claim.etag,
    );
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not finalize the HeyGen pairing session.');
  }
  if (!result.ok) {
    throw brokerError('heygen_store_unavailable', 'Could not finalize the HeyGen pairing session.');
  }
}

// -------------------------------------------------------------------------------------------------
// Upstream calls (sanitized)
// -------------------------------------------------------------------------------------------------

export interface HeyGenRawResponse {
  status: number;
  ok: boolean;
  body: unknown;
  retryAfterMs?: number;
}

async function readResponseJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw brokerError('heygen_response_invalid', 'HeyGen returned an invalid response.');
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw brokerError('heygen_response_invalid', 'HeyGen returned an invalid response.');
  }
}

function retryAfterMilliseconds(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(30_000, Number(value) * 1000);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(30_000, Math.max(0, parsed - nowMs));
}

export async function heyGenApiGet(
  path: string,
  accessToken: string,
  query: Record<string, string | undefined>,
  deps: HeyGenBrokerDeps,
): Promise<HeyGenRawResponse> {
  const url = new URL(path, HEYGEN_API_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw brokerError('heygen_unavailable', 'HeyGen is temporarily unavailable.');
  }
  let body: unknown = null;
  try {
    body = await readResponseJson(response);
  } catch (error) {
    if (!response.ok) body = null;
    else throw error;
  }
  return {
    status: response.status,
    ok: response.ok,
    body,
    retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after'), deps.now()),
  };
}

export async function heyGenApiPatch(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
  deps: HeyGenBrokerDeps,
): Promise<HeyGenRawResponse> {
  let response: Response;
  try {
    response = await deps.fetchImpl(new URL(path, HEYGEN_API_BASE), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw brokerError('heygen_unavailable', 'HeyGen is temporarily unavailable.');
  }
  let responseBody: unknown = null;
  try {
    responseBody = await readResponseJson(response);
  } catch (error) {
    if (!response.ok) responseBody = null;
    else throw error;
  }
  return {
    status: response.status,
    ok: response.ok,
    body: responseBody,
    retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after'), deps.now()),
  };
}

export async function heyGenApiPost(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
  deps: HeyGenBrokerDeps,
  extraHeaders: Record<string, string> = {},
): Promise<HeyGenRawResponse> {
  let response: Response;
  try {
    response = await deps.fetchImpl(new URL(path, HEYGEN_API_BASE), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw brokerError('heygen_unavailable', 'HeyGen is temporarily unavailable.');
  }
  let responseBody: unknown = null;
  try {
    responseBody = await readResponseJson(response);
  } catch (error) {
    if (!response.ok) responseBody = null;
    else throw error;
  }
  return {
    status: response.status,
    ok: response.ok,
    body: responseBody,
    retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after'), deps.now()),
  };
}

/** Verify that the bearer resolves to a populated subscription account. */
export async function verifyHeyGenSubscription(
  accessToken: string,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<unknown> {
  const response = await heyGenApiGet('/v3/users/me', accessToken, {}, deps);
  if (!response.ok) {
    throw brokerError(
      'heygen_account_verification_failed',
      `HeyGen account verification failed (HTTP ${response.status}).`,
      response.status === 401 ? 401 : 502,
    );
  }
  assertSubscriptionAccount(response.body);
  return response.body;
}

interface RefreshResult {
  state: HeyGenTokenState;
}

export async function refreshHeyGenToken(
  previous: HeyGenTokenState,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<RefreshResult> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
    client_id: HEYGEN_OAUTH_CLIENT_ID,
  });
  let response: Response;
  try {
    response = await deps.fetchImpl(HEYGEN_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw brokerError('heygen_refresh_failed', 'HeyGen OAuth refresh did not complete.');
  }
  const body = await readResponseJson(response).catch(() => null);
  if (!response.ok) {
    throw brokerError(
      'heygen_refresh_failed',
      `HeyGen OAuth refresh failed (HTTP ${response.status}).`,
      response.status === 400 || response.status === 401 ? 401 : 502,
    );
  }
  const parsed = z
    .object({
      access_token: headerSafeToken,
      refresh_token: headerSafeToken.optional(),
      expires_in: z
        .union([
          z.number().finite().positive().max(31_536_000),
          z.string().regex(/^\d{1,8}$/),
        ])
        .optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
    })
    .passthrough()
    .safeParse(body);
  if (!parsed.success) {
    throw brokerError('heygen_refresh_invalid', 'HeyGen OAuth refresh returned an invalid token response.');
  }
  const expiresIn = parsed.data.expires_in === undefined ? 3600 : Number(parsed.data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31_536_000) {
    throw brokerError('heygen_refresh_invalid', 'HeyGen OAuth refresh returned an invalid token response.');
  }
  return {
    state: {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? previous.refreshToken,
      expiresAt: deps.now() + expiresIn * 1000,
      scope: parsed.data.scope ?? previous.scope,
      tokenType: parsed.data.token_type ?? previous.tokenType,
    },
  };
}

/** Persist a newly paired token, replacing any prior pairing only through an ETag write. */
export async function persistPairedHeyGenToken(
  state: HeyGenTokenState,
  userResponse: unknown,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenTokenDoc> {
  const secret = requireHeyGenSigningSecret(deps);
  const next = buildHeyGenTokenDoc({
    state,
    signingSecret: secret,
    userResponse,
    nowMs: deps.now(),
    randomBytesImpl: deps.randomBytes,
  });
  let existing: Awaited<ReturnType<CosmosRead>>;
  try {
    existing = await deps.read(CACHE_CONTAINER, HEYGEN_TOKEN_DOC_ID, HEYGEN_TOKEN_DOC_ID);
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not persist the HeyGen OAuth session.');
  }
  if (!existing) {
    try {
      await deps.create(CACHE_CONTAINER, HEYGEN_TOKEN_DOC_ID, next);
      return next;
    } catch {
      throw brokerError('heygen_store_unavailable', 'Could not persist the HeyGen OAuth session.');
    }
  }
  if (!existing.etag) {
    throw brokerError('heygen_store_unavailable', 'Could not safely replace the HeyGen OAuth session.');
  }
  let result: Awaited<ReturnType<CosmosReplace>>;
  try {
    result = await deps.replace(
      CACHE_CONTAINER,
      HEYGEN_TOKEN_DOC_ID,
      HEYGEN_TOKEN_DOC_ID,
      next,
      existing.etag,
    );
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not persist the HeyGen OAuth session.');
  }
  if (result.status === 412) {
    throw brokerError(
      'heygen_pairing_race_lost',
      'Another HeyGen pairing replaced the OAuth session first; this pairing was not persisted.',
      409,
    );
  }
  if (!result.ok) {
    throw brokerError('heygen_store_unavailable', 'Could not persist the HeyGen OAuth session.');
  }
  return next;
}

// -------------------------------------------------------------------------------------------------
// Durable refresh manager
// -------------------------------------------------------------------------------------------------

const tokenLocks = new Map<string, Promise<unknown>>();

async function withTokenLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = tokenLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => gate);
  tokenLocks.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (tokenLocks.get(key) === tail) tokenLocks.delete(key);
  }
}

interface LiveTokenRead {
  doc: HeyGenTokenDoc;
  etag: string;
  state: HeyGenTokenState;
}

async function readLiveToken(deps: HeyGenBrokerDeps, secret: string): Promise<LiveTokenRead> {
  let row: Awaited<ReturnType<CosmosRead>>;
  try {
    row = await deps.read(CACHE_CONTAINER, HEYGEN_TOKEN_DOC_ID, HEYGEN_TOKEN_DOC_ID);
  } catch {
    throw brokerError('heygen_store_unavailable', 'Could not read the HeyGen OAuth session.');
  }
  if (!row || !row.etag || !isTokenDoc(row.doc)) {
    throw brokerError('heygen_not_paired', 'HeyGen is not paired. Start a new CTO pairing session.', 409);
  }
  return {
    doc: row.doc,
    etag: row.etag,
    state: decryptHeyGenTokenState(encryptedStateFromDoc(row.doc), secret),
  };
}

function tokenIsFresh(state: HeyGenTokenState, nowMs: number): boolean {
  return state.expiresAt === 0 || state.expiresAt > nowMs + HEYGEN_REFRESH_MARGIN_MS;
}

async function adoptRefreshWinner(
  deps: HeyGenBrokerDeps,
  secret: string,
  familyFingerprint: string,
): Promise<HeyGenTokenState | null> {
  let row: Awaited<ReturnType<CosmosRead>>;
  try {
    row = await deps.read(CACHE_CONTAINER, HEYGEN_TOKEN_DOC_ID, HEYGEN_TOKEN_DOC_ID);
  } catch {
    return null;
  }
  if (!row || !isTokenDoc(row.doc) || row.doc.familyFingerprint !== familyFingerprint) return null;
  const state = decryptHeyGenTokenState(encryptedStateFromDoc(row.doc), secret);
  return tokenIsFresh(state, deps.now()) ? state : null;
}

/**
 * Return a live access token. A refresh is persisted (encrypted) before return. On a 412, this replica
 * discards its rotated fork and adopts the fresh winner written by another replica.
 */
export async function getHeyGenAccessToken(
  options: { forceRefresh?: boolean; rejectedAccessToken?: string; deps?: HeyGenBrokerDeps } = {},
): Promise<string> {
  const deps = options.deps ?? defaultHeyGenBrokerDeps;
  const secret = requireHeyGenSigningSecret(deps);
  return withTokenLock(HEYGEN_TOKEN_DOC_ID, async () => {
    const current = await readLiveToken(deps, secret);
    if (!options.forceRefresh && tokenIsFresh(current.state, deps.now())) {
      return current.state.accessToken;
    }
    if (
      options.forceRefresh &&
      options.rejectedAccessToken &&
      current.state.accessToken !== options.rejectedAccessToken &&
      tokenIsFresh(current.state, deps.now())
    ) {
      // Another request in this replica (or another replica through Cosmos) already replaced the
      // exact token that received the 401. Adopt it instead of rotating a fresh chain a second time.
      return current.state.accessToken;
    }

    let refreshed: RefreshResult;
    try {
      refreshed = await refreshHeyGenToken(current.state, deps);
    } catch (error) {
      if (error instanceof HeyGenBrokerError && error.code === 'heygen_refresh_failed' && error.httpStatus === 401) {
        // A rotate-on-use refresh token may already have been consumed by another replica. Never mark
        // the family dead from this replica's stale view; adopt a fresh same-family winner if present.
        const winner = await adoptRefreshWinner(deps, secret, current.doc.familyFingerprint);
        if (winner) return winner.accessToken;
      }
      throw error;
    }
    const next = buildHeyGenTokenDoc({
      state: refreshed.state,
      signingSecret: secret,
      // The stored live document can only have been created after a successful subscription check;
      // no user/account fields are persisted. This marker satisfies the builder's invariant without
      // widening the plaintext document.
      userResponse: {
        data: {
          billing_type: 'subscription',
          subscription: { verified: true },
        },
      },
      nowMs: deps.now(),
      pairedAt: current.doc.pairedAt,
      familyFingerprint: current.doc.familyFingerprint,
      randomBytesImpl: deps.randomBytes,
    });

    let result: Awaited<ReturnType<CosmosReplace>>;
    try {
      result = await deps.replace(
        CACHE_CONTAINER,
        HEYGEN_TOKEN_DOC_ID,
        HEYGEN_TOKEN_DOC_ID,
        next,
        current.etag,
      );
    } catch {
      throw brokerError(
        'heygen_token_persist_failed',
        'HeyGen token refresh could not be persisted; the rotated access token was not returned.',
      );
    }
    if (result.status === 412) {
      const winner = await adoptRefreshWinner(
        deps,
        secret,
        current.doc.familyFingerprint,
      );
      if (winner) return winner.accessToken;
      throw brokerError(
        'heygen_refresh_race_lost',
        'HeyGen token refresh lost a concurrency race and no usable winner was available; retry.',
      );
    }
    if (!result.ok) {
      throw brokerError(
        'heygen_token_persist_failed',
        'HeyGen token refresh could not be persisted; the rotated access token was not returned.',
      );
    }
    return refreshed.state.accessToken;
  });
}

// -------------------------------------------------------------------------------------------------
// Fixed v3 data operations and the bounded prompt-avatar creation
// -------------------------------------------------------------------------------------------------

export type HeyGenReadOperation =
  | { kind: 'account' }
  | { kind: 'videos'; limit?: number; token?: string; folderId?: string; title?: string }
  | { kind: 'video'; videoId: string }
  | { kind: 'styles'; tag?: string; limit?: number; token?: string }
  | { kind: 'videoStatuses'; videoIds?: string[]; batchIds?: string[] }
  | { kind: 'videoAgentSessions'; limit?: number; token?: string }
  | { kind: 'videoAgentSession'; sessionId: string }
  | { kind: 'videoAgentSessionVideos'; sessionId: string }
  | { kind: 'videoAgentResource'; sessionId: string; resourceId: string }
  | { kind: 'asset'; assetId: string }
  | { kind: 'assetStatuses'; assetIds?: string[]; batchIds?: string[] }
  | { kind: 'brandKits'; limit?: number; token?: string }
  | { kind: 'brandGlossaries'; limit?: number; token?: string }
  | { kind: 'brandGlossary'; brandGlossaryId: string }
  | { kind: 'avatarGroups'; ownership?: 'public' | 'private'; limit?: number; token?: string }
  | { kind: 'avatarGroup'; groupId: string }
  | {
      kind: 'avatarLooks';
      groupId?: string;
      avatarType?: 'studio_avatar' | 'digital_twin' | 'photo_avatar';
      ownership?: 'public' | 'private';
      limit?: number;
      token?: string;
    }
  | { kind: 'avatarLook'; lookId: string }
  | { kind: 'voice'; voiceId: string }
  | {
      kind: 'voices';
      type?: 'public' | 'private';
      engine?: string;
      language?: string;
      gender?: string;
      limit?: number;
      token?: string;
    }
  | { kind: 'translationLanguages' }
  | { kind: 'translations'; limit?: number; token?: string }
  | { kind: 'translation'; translationId: string }
  | { kind: 'translationStatuses'; translationIds?: string[]; batchIds?: string[] }
  | { kind: 'proofread'; proofreadId: string }
  | {
      kind: 'voiceDesign';
      prompt: string;
      gender?: 'male' | 'female';
      locale?: string;
      seed?: number;
    };

interface HeyGenGetTarget {
  method: 'GET';
  path: string;
  query: Record<string, string | undefined>;
}

interface HeyGenPostTarget {
  method: 'POST';
  path: string;
  body: Record<string, unknown>;
}

type HeyGenTarget = HeyGenGetTarget | HeyGenPostTarget;

function assertSafeHeyGenId(value: string, field: string): void {
  if (!HEYGEN_SAFE_ID_RE.test(value)) {
    throw brokerError(`heygen_${field}_invalid`, `HeyGen ${field} contains unsupported characters.`, 400);
  }
}

function assertPaginationToken(token: string | undefined): void {
  if (token !== undefined && token.length > 4096) {
    throw brokerError('heygen_token_invalid', 'HeyGen pagination token exceeds 4096 characters.', 400);
  }
}

function assertIntegerRange(value: number | undefined, min: number, max: number, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    throw brokerError(
      `heygen_${field}_invalid`,
      `HeyGen ${field} must be an integer from ${min} to ${max}.`,
      400,
    );
  }
}

function commaSeparatedIds(values: string[] | undefined, field: string): string | undefined {
  if (values === undefined) return undefined;
  if (values.length < 1 || values.length > 100) {
    throw brokerError(`heygen_${field}_invalid`, `HeyGen ${field} must contain 1-100 ids.`, 400);
  }
  for (const value of values) assertSafeHeyGenId(value, field);
  return values.join(',');
}

function assertAtLeastOneIdSet(first: string[] | undefined, second: string[] | undefined, label: string): void {
  if ((!first || first.length === 0) && (!second || second.length === 0)) {
    throw brokerError(`heygen_${label}_required`, `HeyGen ${label} requires at least one id.`, 400);
  }
  if ((first?.length ?? 0) + (second?.length ?? 0) > 100) {
    throw brokerError(`heygen_${label}_invalid`, `HeyGen ${label} accepts at most 100 ids total.`, 400);
  }
}

function targetForOperation(operation: Exclude<HeyGenReadOperation, { kind: 'account' }>): HeyGenTarget {
  switch (operation.kind) {
    case 'videos':
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/videos',
        query: {
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
          folder_id: operation.folderId,
          title: operation.title,
        },
      };
    case 'video':
      assertSafeHeyGenId(operation.videoId, 'video_id');
      return {
        method: 'GET',
        path: `/v3/videos/${operation.videoId}`,
        query: {},
      };
    case 'styles':
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/video-agents/styles',
        query: {
          tag: operation.tag,
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'videoStatuses':
      assertAtLeastOneIdSet(operation.videoIds, operation.batchIds, 'video_status_ids');
      return {
        method: 'GET',
        path: '/v3/videos/statuses',
        query: {
          video_ids: commaSeparatedIds(operation.videoIds, 'video_ids'),
          batch_ids: commaSeparatedIds(operation.batchIds, 'batch_ids'),
        },
      };
    case 'videoAgentSessions':
      assertIntegerRange(operation.limit, 1, 100, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/video-agents',
        query: {
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'videoAgentSession':
      assertSafeHeyGenId(operation.sessionId, 'session_id');
      return { method: 'GET', path: `/v3/video-agents/${operation.sessionId}`, query: {} };
    case 'videoAgentSessionVideos':
      assertSafeHeyGenId(operation.sessionId, 'session_id');
      return { method: 'GET', path: `/v3/video-agents/${operation.sessionId}/videos`, query: {} };
    case 'videoAgentResource':
      assertSafeHeyGenId(operation.sessionId, 'session_id');
      assertSafeHeyGenId(operation.resourceId, 'resource_id');
      return {
        method: 'GET',
        path: `/v3/video-agents/${operation.sessionId}/resources/${operation.resourceId}`,
        query: {},
      };
    case 'asset':
      assertSafeHeyGenId(operation.assetId, 'asset_id');
      return { method: 'GET', path: `/v3/assets/${operation.assetId}`, query: {} };
    case 'assetStatuses':
      assertAtLeastOneIdSet(operation.assetIds, operation.batchIds, 'asset_status_ids');
      return {
        method: 'GET',
        path: '/v3/assets/statuses',
        query: {
          asset_ids: commaSeparatedIds(operation.assetIds, 'asset_ids'),
          batch_ids: commaSeparatedIds(operation.batchIds, 'batch_ids'),
        },
      };
    case 'brandKits':
      assertIntegerRange(operation.limit, 1, 100, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/brand-kits',
        query: {
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'brandGlossaries':
      assertIntegerRange(operation.limit, 1, 100, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/brand-glossaries',
        query: {
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'brandGlossary':
      assertSafeHeyGenId(operation.brandGlossaryId, 'brand_glossary_id');
      return { method: 'GET', path: `/v3/brand-glossaries/${operation.brandGlossaryId}`, query: {} };
    case 'avatarGroups':
      if (operation.ownership !== undefined && operation.ownership !== 'public' && operation.ownership !== 'private') {
        throw brokerError('heygen_ownership_invalid', 'HeyGen ownership must be public or private.', 400);
      }
      assertIntegerRange(operation.limit, 1, 50, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/avatars',
        query: {
          ownership: operation.ownership,
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'avatarGroup':
      assertSafeHeyGenId(operation.groupId, 'group_id');
      return {
        method: 'GET',
        path: `/v3/avatars/${operation.groupId}`,
        query: {},
      };
    case 'avatarLooks':
      if (operation.groupId !== undefined) assertSafeHeyGenId(operation.groupId, 'group_id');
      if (
        operation.avatarType !== undefined &&
        operation.avatarType !== 'studio_avatar' &&
        operation.avatarType !== 'digital_twin' &&
        operation.avatarType !== 'photo_avatar'
      ) {
        throw brokerError('heygen_avatar_type_invalid', 'HeyGen avatar_type is unsupported.', 400);
      }
      if (operation.ownership !== undefined && operation.ownership !== 'public' && operation.ownership !== 'private') {
        throw brokerError('heygen_ownership_invalid', 'HeyGen ownership must be public or private.', 400);
      }
      assertIntegerRange(operation.limit, 1, 50, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/avatars/looks',
        query: {
          group_id: operation.groupId,
          avatar_type: operation.avatarType,
          ownership: operation.ownership,
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'avatarLook':
      assertSafeHeyGenId(operation.lookId, 'look_id');
      return {
        method: 'GET',
        path: `/v3/avatars/looks/${operation.lookId}`,
        query: {},
      };
    case 'voice':
      assertSafeHeyGenId(operation.voiceId, 'voice_id');
      return { method: 'GET', path: `/v3/voices/${operation.voiceId}`, query: {} };
    case 'voices':
      if (operation.type !== undefined && operation.type !== 'public' && operation.type !== 'private') {
        throw brokerError('heygen_voice_type_invalid', 'HeyGen voice type must be public or private.', 400);
      }
      if (operation.engine !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(operation.engine)) {
        throw brokerError('heygen_voice_engine_invalid', 'HeyGen voice engine contains unsupported characters.', 400);
      }
      if (operation.language !== undefined && (operation.language.trim().length < 1 || operation.language.length > 64)) {
        throw brokerError('heygen_voice_language_invalid', 'HeyGen voice language must be 1-64 characters.', 400);
      }
      if (operation.gender !== undefined && operation.gender !== 'male' && operation.gender !== 'female') {
        throw brokerError('heygen_voice_gender_invalid', 'HeyGen voice gender must be male or female.', 400);
      }
      assertIntegerRange(operation.limit, 1, 100, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/voices',
        query: {
          type: operation.type,
          engine: operation.engine,
          language: operation.language?.trim(),
          gender: operation.gender,
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'translationLanguages':
      return { method: 'GET', path: '/v3/video-translations/languages', query: {} };
    case 'translations':
      assertIntegerRange(operation.limit, 1, 100, 'limit');
      assertPaginationToken(operation.token);
      return {
        method: 'GET',
        path: '/v3/video-translations',
        query: {
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
    case 'translation':
      assertSafeHeyGenId(operation.translationId, 'video_translation_id');
      return { method: 'GET', path: `/v3/video-translations/${operation.translationId}`, query: {} };
    case 'translationStatuses':
      assertAtLeastOneIdSet(operation.translationIds, operation.batchIds, 'translation_status_ids');
      return {
        method: 'GET',
        path: '/v3/video-translations/statuses',
        query: {
          video_translation_ids: commaSeparatedIds(operation.translationIds, 'video_translation_ids'),
          batch_ids: commaSeparatedIds(operation.batchIds, 'batch_ids'),
        },
      };
    case 'proofread':
      assertSafeHeyGenId(operation.proofreadId, 'proofread_id');
      return { method: 'GET', path: `/v3/video-translations/proofreads/${operation.proofreadId}`, query: {} };
    case 'voiceDesign': {
      if (
        typeof operation.prompt !== 'string' ||
        operation.prompt.trim().length < 1 ||
        operation.prompt.length > 1000
      ) {
        throw brokerError('heygen_voice_prompt_invalid', 'HeyGen voice-design prompt must be 1-1000 characters.', 400);
      }
      if (operation.gender !== undefined && operation.gender !== 'male' && operation.gender !== 'female') {
        throw brokerError('heygen_voice_gender_invalid', 'HeyGen voice-design gender must be male or female.', 400);
      }
      if (operation.locale !== undefined && !HEYGEN_LOCALE_RE.test(operation.locale)) {
        throw brokerError('heygen_voice_locale_invalid', 'HeyGen voice-design locale must be a BCP-47-like tag.', 400);
      }
      if (operation.seed !== undefined && (!Number.isInteger(operation.seed) || operation.seed < 0)) {
        throw brokerError('heygen_voice_seed_invalid', 'HeyGen voice-design seed must be a non-negative integer.', 400);
      }
      const body: Record<string, unknown> = { prompt: operation.prompt.trim() };
      if (operation.gender !== undefined) body.gender = operation.gender;
      if (operation.locale !== undefined) body.locale = operation.locale;
      if (operation.seed !== undefined) body.seed = operation.seed;
      return { method: 'POST', path: '/v3/voices', body };
    }
  }
  throw brokerError('heygen_operation_invalid', 'Unsupported HeyGen data operation.', 400);
}

/**
 * Run one of the fixed read/semantic-search operations. Every attempt performs GET /v3/users/me
 * immediately before its target and refuses non-subscription accounts before the target request can
 * be sent. A 401 from either the guard or target triggers exactly one forced refresh and one full
 * retry; no other failure is retried.
 */
export async function executeHeyGenRead(
  operation: HeyGenReadOperation,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<unknown> {
  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getHeyGenAccessToken({
      forceRefresh: attempt === 1,
      rejectedAccessToken,
      deps,
    });
    const guard = await heyGenApiGet('/v3/users/me', accessToken, {}, deps);
    if (guard.status === 401 && attempt === 0) {
      rejectedAccessToken = accessToken;
      continue;
    }
    if (!guard.ok) {
      throw brokerError(
        'heygen_account_guard_failed',
        `HeyGen subscription guard failed (HTTP ${guard.status}).`,
        guard.status === 401 ? 401 : 502,
      );
    }
    assertSubscriptionAccount(guard.body);
    if (operation.kind === 'account') return guard.body;

    // Keep this call immediately adjacent to the successful subscription check above. No other
    // network request is permitted between /v3/users/me and the fixed target route.
    const target = targetForOperation(operation);
    const response = target.method === 'GET'
      ? await heyGenApiGet(target.path, accessToken, target.query, deps)
      : await heyGenApiPost(target.path, accessToken, target.body, deps);
    if (response.status === 401 && attempt === 0) {
      rejectedAccessToken = accessToken;
      continue;
    }
    if (!response.ok) {
      throw brokerError(
        'heygen_operation_failed',
        `HeyGen operation failed (HTTP ${response.status}).`,
        response.status === 401 ? 401 : 502,
      );
    }
    return response.body;
  }
  throw brokerError('heygen_auth_failed', 'HeyGen OAuth authorization failed after one refresh retry.', 401);
}

export interface HeyGenPromptAvatarCreateInput {
  name: string;
  prompt: string;
  avatarGroupId?: string;
  confirmCreditUse: boolean;
  confirmedPremiumCreditsBefore: number;
}

export interface HeyGenPromptAvatarCreateResult {
  body: unknown;
  plan: string;
  premiumCreditsBefore: number;
}

function validatePromptAvatarCreateInput(input: HeyGenPromptAvatarCreateInput): void {
  if (input.confirmCreditUse !== true) {
    throw brokerError(
      'heygen_credit_confirmation_required',
      'HeyGen prompt-avatar creation requires confirm_credit_use=true.',
      400,
    );
  }
  if (!Number.isInteger(input.confirmedPremiumCreditsBefore) || input.confirmedPremiumCreditsBefore < 0) {
    throw brokerError(
      'heygen_credit_snapshot_invalid',
      'confirmed_premium_credits_before must be a non-negative integer from a recent HeyGen account check.',
      400,
    );
  }
  if (
    typeof input.name !== 'string' ||
    input.name.trim().length < 1 ||
    input.name.length > 100
  ) {
    throw brokerError('heygen_avatar_name_invalid', 'HeyGen avatar name must be 1-100 characters.', 400);
  }
  if (
    typeof input.prompt !== 'string' ||
    input.prompt.trim().length < 1 ||
    input.prompt.length > 1000
  ) {
    throw brokerError('heygen_avatar_prompt_invalid', 'HeyGen avatar prompt must be 1-1000 characters.', 400);
  }
  if (input.avatarGroupId !== undefined) assertSafeHeyGenId(input.avatarGroupId, 'avatar_group_id');
}

function premiumCreditSnapshot(account: unknown): { plan: string; remaining: number } {
  assertSubscriptionAccount(account);
  const data = (account as { data: Record<string, unknown> }).data;
  const subscription = data.subscription as Record<string, unknown>;
  const credits = subscription.credits;
  const premiumCredits =
    credits && typeof credits === 'object' && !Array.isArray(credits)
      ? (credits as Record<string, unknown>).premium_credits
      : undefined;
  const remaining =
    premiumCredits && typeof premiumCredits === 'object' && !Array.isArray(premiumCredits)
      ? (premiumCredits as Record<string, unknown>).remaining
      : undefined;
  const plan = subscription.plan;
  if (typeof plan !== 'string' || plan.length === 0 || typeof remaining !== 'number' || !Number.isInteger(remaining)) {
    throw brokerError(
      'heygen_premium_credit_balance_unavailable',
      'HeyGen did not return an integer premium-credit balance. Recheck the subscription account before creating an avatar.',
      409,
    );
  }
  return { plan, remaining: remaining as number };
}

/**
 * Create exactly one prompt avatar after binding explicit user approval to the live premium-credit
 * balance returned immediately before POST /v3/avatars. Only an authentication rejection (401) may
 * trigger one forced refresh and one complete retry; ambiguous/network/429/5xx responses are final.
 */
export async function executeHeyGenPromptAvatarCreate(
  input: HeyGenPromptAvatarCreateInput,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenPromptAvatarCreateResult> {
  validatePromptAvatarCreateInput(input);
  const body: Record<string, unknown> = {
    type: 'prompt',
    name: input.name.trim(),
    prompt: input.prompt.trim(),
  };
  if (input.avatarGroupId !== undefined) body.avatar_group_id = input.avatarGroupId;

  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getHeyGenAccessToken({
      forceRefresh: attempt === 1,
      rejectedAccessToken,
      deps,
    });
    const guard = await heyGenApiGet('/v3/users/me', accessToken, {}, deps);
    if (guard.status === 401 && attempt === 0) {
      rejectedAccessToken = accessToken;
      continue;
    }
    if (!guard.ok) {
      throw brokerError(
        'heygen_account_guard_failed',
        `HeyGen subscription guard failed (HTTP ${guard.status}).`,
        guard.status === 401 ? 401 : 502,
      );
    }
    const snapshot = premiumCreditSnapshot(guard.body);
    if (snapshot.remaining < 1) {
      throw brokerError(
        'heygen_premium_credits_insufficient',
        'HeyGen prompt-avatar creation requires at least 1 remaining premium credit. No avatar was created.',
        409,
      );
    }
    if (snapshot.remaining !== input.confirmedPremiumCreditsBefore) {
      throw brokerError(
        'heygen_credit_snapshot_mismatch',
        `HeyGen premium-credit balance changed: confirmed ${input.confirmedPremiumCreditsBefore}, current ${snapshot.remaining}. Reconfirm the current balance and retry. No avatar was created.`,
        409,
      );
    }

    // The successful subscription/credit snapshot above is the final network operation before POST.
    // A timeout/network failure or malformed success response is AMBIGUOUS for a non-idempotent
    // create: the upstream may have accepted the avatar even though the response never reached us.
    // Surface that distinction so callers inspect private avatars before ever considering a retry.
    let response: HeyGenRawResponse;
    try {
      response = await heyGenApiPost('/v3/avatars', accessToken, body, deps);
    } catch {
      throw brokerError(
        'heygen_avatar_create_outcome_unknown',
        'HeyGen avatar creation returned no trustworthy response. The avatar may have been accepted. List private avatar groups before retrying; no automatic retry was attempted.',
        502,
      );
    }
    if (response.status === 401 && attempt === 0) {
      rejectedAccessToken = accessToken;
      continue;
    }
    if (!response.ok) {
      throw brokerError(
        'heygen_avatar_create_failed',
        `HeyGen prompt-avatar creation failed (HTTP ${response.status}). The request was not retried; check HeyGen before trying again.`,
        response.status === 401 ? 401 : 502,
      );
    }
    return {
      body: response.body,
      plan: snapshot.plan,
      premiumCreditsBefore: snapshot.remaining,
    };
  }
  throw brokerError('heygen_auth_failed', 'HeyGen OAuth authorization failed after one refresh retry.', 401);
}

// -------------------------------------------------------------------------------------------------
// Idempotent direct Avatar Video operation
// -------------------------------------------------------------------------------------------------

const HEYGEN_VIDEO_OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const HEYGEN_VIDEO_SUBMIT_LEASE_MS = 60_000;
const HEYGEN_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HeyGenVideoOperationState =
  | 'ready'
  | 'submitting'
  | 'accepted'
  | 'rejected'
  | 'outcome_unknown';

export interface HeyGenVideoOperationDoc extends Record<string, unknown> {
  id: string;
  cacheScope: string;
  ttl: number;
  kind: 'heygen_avatar_video_operation';
  version: 1 | 2;
  operationId: string;
  idempotencyKeySha256: string;
  manifestSha256: string;
  requestSha256: string;
  scriptSha256: string;
  state: HeyGenVideoOperationState;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  plan: string;
  premiumCreditsConfirmed: number;
  confirmedBillingSnapshotSha256: string;
  confirmedBillingStateSha256: string;
  confirmedBillingObservedAt: string;
  grantIdSha256?: string;
  premiumCreditsBefore?: number;
  premiumCreditsAfter?: number;
  actualCreditDelta?: number;
  billingBeforeSha256?: string;
  billingAfterSha256?: string;
  maxApprovedCredits: number;
  reservePremiumCredits: number;
  estimatedCredits: number;
  estimatedDurationSeconds: number;
  avatarId: string;
  voiceId: string;
  engine: string;
  productionProfile?: HeyGenAvatarVideoPlan['productionProfile'];
  familyStoryFounder?: HeyGenAvatarVideoPlan['familyStoryFounder'];
  personalizedMotion?: boolean;
  pauseSeconds?: number;
  firstSubmittedAt?: string;
  providerWindowExpiresAt?: string;
  leaseExpiresAt?: string;
  videoId?: string;
  providerStatus?: string;
  upstreamStatus?: number;
  lastErrorCode?: string;
}

export interface HeyGenAvatarVideoCreateResult {
  operationId: string;
  state: HeyGenVideoOperationState | 'dry_run' | 'in_progress';
  replayed: boolean;
  requestSha256: string;
  videoId?: string;
  providerStatus?: string;
  plan: string;
  premiumCreditsBefore?: number;
  premiumCreditsAfter?: number;
  actualCreditDelta?: number;
  billingSnapshotBeforeSha256?: string;
  billingSnapshotAfterSha256?: string;
  maxApprovedCredits: number;
  reservePremiumCredits: number;
  estimatedCredits: number;
  estimatedDurationSeconds: number;
  pauseSeconds?: number;
  productionProfile?: HeyGenAvatarVideoPlan['productionProfile'];
  familyStoryFounder?: HeyGenAvatarVideoPlan['familyStoryFounder'];
  personalizedMotion?: boolean;
  photoFallback?: boolean;
  providerIdempotencyExpiresAt?: string;
  errorCode?: string;
}

function videoOperationDocId(operationId: string): string {
  return `heygen.video.${operationId}`;
}

function isVideoOperationDoc(value: unknown): value is HeyGenVideoOperationDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<HeyGenVideoOperationDoc>;
  return (
    typeof doc.id === 'string' &&
    doc.cacheScope === doc.id &&
    doc.kind === 'heygen_avatar_video_operation' &&
    (doc.version === 1 || doc.version === 2) &&
    doc.ttl === HEYGEN_VIDEO_OPERATION_TTL_SECONDS &&
    typeof doc.operationId === 'string' &&
    typeof doc.requestSha256 === 'string' &&
    typeof doc.manifestSha256 === 'string' &&
    typeof doc.idempotencyKeySha256 === 'string' &&
    ['ready', 'submitting', 'accepted', 'rejected', 'outcome_unknown'].includes(String(doc.state))
  );
}

function operationView(
  doc: HeyGenVideoOperationDoc,
  replayed: boolean,
  nowMs = Date.now(),
): HeyGenAvatarVideoCreateResult {
  const leaseActive =
    doc.state === 'submitting' && Boolean(doc.leaseExpiresAt) && Date.parse(doc.leaseExpiresAt!) > nowMs;
  return {
    operationId: doc.operationId,
    state: leaseActive ? 'in_progress' : doc.state,
    replayed,
    requestSha256: doc.requestSha256,
    videoId: doc.videoId,
    providerStatus: doc.providerStatus,
    plan: doc.plan,
    premiumCreditsBefore: doc.premiumCreditsBefore,
    premiumCreditsAfter: doc.premiumCreditsAfter,
    actualCreditDelta: doc.actualCreditDelta,
    billingSnapshotBeforeSha256: doc.billingBeforeSha256,
    billingSnapshotAfterSha256: doc.billingAfterSha256,
    maxApprovedCredits: doc.maxApprovedCredits,
    reservePremiumCredits: doc.reservePremiumCredits,
    estimatedCredits: doc.estimatedCredits,
    estimatedDurationSeconds: doc.estimatedDurationSeconds,
    pauseSeconds: doc.pauseSeconds,
    productionProfile: doc.productionProfile,
    familyStoryFounder: doc.familyStoryFounder,
    personalizedMotion: doc.personalizedMotion,
    photoFallback: doc.productionProfile === 'family_story_photo_fallback',
    providerIdempotencyExpiresAt: doc.providerWindowExpiresAt,
    errorCode: doc.lastErrorCode,
  };
}

function assertSameVideoOperation(
  doc: HeyGenVideoOperationDoc,
  input: HeyGenAvatarVideoCreateInput,
  plan: HeyGenAvatarVideoPlan,
): void {
  const same =
    doc.idempotencyKeySha256 === plan.idempotencyKeySha256 &&
    doc.manifestSha256 === input.manifestSha256 &&
    doc.requestSha256 === plan.requestSha256 &&
    doc.scriptSha256 === plan.scriptSha256 &&
    doc.premiumCreditsConfirmed === input.confirmedPremiumCreditsBefore &&
    doc.confirmedBillingSnapshotSha256 === input.confirmedBillingSnapshotSha256 &&
    doc.confirmedBillingStateSha256 === input.confirmedBillingStateSha256 &&
    doc.confirmedBillingObservedAt === input.confirmedBillingObservedAt &&
    (doc.productionProfile ?? 'standard') === plan.productionProfile &&
    doc.familyStoryFounder === plan.familyStoryFounder &&
    Boolean(doc.personalizedMotion) === plan.personalizedMotion &&
    (doc.pauseSeconds ?? 0) === plan.pauseSeconds &&
    doc.maxApprovedCredits === input.maxApprovedCredits &&
    doc.reservePremiumCredits === input.reservePremiumCredits;
  if (!same) {
    throw brokerError(
      'heygen_video_idempotency_conflict',
      'This operation_id was already bound to a different request, manifest, idempotency key, or approval envelope.',
      409,
    );
  }
}

function assertSameTerminalReplay(
  doc: HeyGenVideoOperationDoc,
  input: HeyGenAvatarVideoCreateInput,
  plan: HeyGenAvatarVideoPlan,
): void {
  if (doc.version === 2) {
    assertSameVideoOperation(doc, input, plan);
    return;
  }
  const sameLegacyRequest =
    doc.idempotencyKeySha256 === plan.idempotencyKeySha256 &&
    doc.manifestSha256 === input.manifestSha256 &&
    doc.requestSha256 === plan.requestSha256 &&
    doc.scriptSha256 === plan.scriptSha256;
  if (!sameLegacyRequest) {
    throw brokerError(
      'heygen_video_idempotency_conflict',
      'This legacy operation_id was already bound to a different request, manifest, or idempotency key.',
      409,
    );
  }
}

async function readVideoOperation(
  operationId: string,
  deps: HeyGenBrokerDeps,
): Promise<{ doc: HeyGenVideoOperationDoc; etag: string } | null> {
  const id = videoOperationDocId(operationId);
  let row: Awaited<ReturnType<CosmosRead>>;
  try {
    row = await deps.read(CACHE_CONTAINER, id, id);
  } catch {
    throw brokerError('heygen_video_operation_store_unavailable', 'Could not read the HeyGen video operation.');
  }
  if (!row) return null;
  if (!row.etag || !isVideoOperationDoc(row.doc)) {
    throw brokerError('heygen_video_operation_invalid', 'Stored HeyGen video operation is invalid.', 409);
  }
  return { doc: row.doc, etag: row.etag };
}

async function ensureVideoOperation(
  input: HeyGenAvatarVideoCreateInput,
  plan: HeyGenAvatarVideoPlan,
  deps: HeyGenBrokerDeps,
): Promise<{ doc: HeyGenVideoOperationDoc; etag: string; created: boolean }> {
  const existing = await readVideoOperation(input.operationId, deps);
  if (existing) {
    assertSameVideoOperation(existing.doc, input, plan);
    return { ...existing, created: false };
  }
  const id = videoOperationDocId(input.operationId);
  const now = new Date(deps.now()).toISOString();
  const doc: HeyGenVideoOperationDoc = {
    id,
    cacheScope: id,
    ttl: HEYGEN_VIDEO_OPERATION_TTL_SECONDS,
    kind: 'heygen_avatar_video_operation',
    version: 2,
    operationId: input.operationId,
    idempotencyKeySha256: plan.idempotencyKeySha256,
    manifestSha256: input.manifestSha256,
    requestSha256: plan.requestSha256,
    scriptSha256: plan.scriptSha256,
    state: 'ready',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    plan: '',
    premiumCreditsConfirmed: input.confirmedPremiumCreditsBefore,
    confirmedBillingSnapshotSha256: input.confirmedBillingSnapshotSha256!,
    confirmedBillingStateSha256: input.confirmedBillingStateSha256!,
    confirmedBillingObservedAt: input.confirmedBillingObservedAt!,
    maxApprovedCredits: input.maxApprovedCredits,
    reservePremiumCredits: input.reservePremiumCredits,
    estimatedCredits: plan.estimatedCredits,
    estimatedDurationSeconds: plan.estimatedDurationSeconds,
    avatarId: input.avatarId,
    voiceId: input.voiceId,
    engine: input.engine,
    productionProfile: plan.productionProfile,
    familyStoryFounder: plan.familyStoryFounder,
    personalizedMotion: plan.personalizedMotion,
    pauseSeconds: plan.pauseSeconds,
  };
  try {
    const created = await deps.create(CACHE_CONTAINER, id, doc);
    if (!created.etag) throw new Error('missing etag');
    return { doc, etag: created.etag, created: true };
  } catch {
    const winner = await readVideoOperation(input.operationId, deps);
    if (!winner) {
      throw brokerError('heygen_video_operation_store_unavailable', 'Could not create the HeyGen video operation.');
    }
    assertSameVideoOperation(winner.doc, input, plan);
    return { ...winner, created: false };
  }
}

async function replaceVideoOperation(
  current: { doc: HeyGenVideoOperationDoc; etag: string },
  changes: Partial<HeyGenVideoOperationDoc>,
  deps: HeyGenBrokerDeps,
): Promise<{ doc: HeyGenVideoOperationDoc; etag: string } | null> {
  const next: HeyGenVideoOperationDoc = {
    ...current.doc,
    ...changes,
    id: current.doc.id,
    cacheScope: current.doc.cacheScope,
    updatedAt: new Date(deps.now()).toISOString(),
  };
  let result: Awaited<ReturnType<CosmosReplace>>;
  try {
    result = await deps.replace(CACHE_CONTAINER, next.cacheScope, next.id, next, current.etag);
  } catch {
    throw brokerError('heygen_video_operation_store_unavailable', 'Could not persist the HeyGen video operation.');
  }
  if (result.status === 412) return null;
  if (!result.ok || !result.etag) {
    throw brokerError('heygen_video_operation_store_unavailable', 'Could not persist the HeyGen video operation.');
  }
  return { doc: next, etag: result.etag };
}

function providerErrorCode(body: unknown): string | undefined {
  const candidate = body as { error?: { code?: unknown } } | null;
  return typeof candidate?.error?.code === 'string' ? candidate.error.code.slice(0, 128) : undefined;
}

async function requiredGet(
  path: string,
  accessToken: string,
  deps: HeyGenBrokerDeps,
): Promise<HeyGenRawResponse> {
  return heyGenApiGet(path, accessToken, {}, deps);
}

async function runVideoPreflight(
  input: HeyGenAvatarVideoCreateInput,
  accessToken: string,
  deps: HeyGenBrokerDeps,
): Promise<{
  account: unknown;
  billing: ReturnType<typeof parseHeyGenBillingSnapshot>;
  plan: string;
  credits: number;
  look: HeyGenAvatarLook;
  group: HeyGenAvatarGroup;
  voice: HeyGenVoice;
  referenceLook?: HeyGenAvatarLook;
}> {
  const accountResponse = await requiredGet('/v3/users/me', accessToken, deps);
  if (!accountResponse.ok) throw accountResponse;
  const snapshot = premiumCreditSnapshot(accountResponse.body);
  const billing = parseHeyGenBillingSnapshot(accountResponse.body, new Date(deps.now()).toISOString());

  const lookResponse = await requiredGet(`/v3/avatars/looks/${input.avatarId}`, accessToken, deps);
  if (!lookResponse.ok) throw lookResponse;
  const look = parseHeyGenAvatarLook(lookResponse.body);
  if (look.id !== input.avatarId) {
    throw brokerError('heygen_avatar_lookup_mismatch', 'HeyGen returned the wrong avatar look.', 502);
  }
  const liveFamilyFounder = findHeyGenFamilyStoryFounderByGroupId(look.groupId);
  if (liveFamilyFounder && (input.productionProfile ?? 'standard') === 'standard') {
    throw brokerError(
      'heygen_family_story_profile_required',
      `Look belongs to locked Family Story founder ${liveFamilyFounder}; an explicit Family Story profile is required.`,
      409,
    );
  }
  if (input.familyStoryFounder) {
    const profile = HEYGEN_FAMILY_STORY_PROFILES[input.familyStoryFounder];
    if (look.groupId !== profile.groupId || liveFamilyFounder !== input.familyStoryFounder) {
      throw brokerError('heygen_family_story_group_mismatch', 'Family Story Look does not belong to the owner-locked founder group.', 409);
    }
    if (look.avatarType !== 'photo_avatar' || look.status !== 'completed') {
      throw brokerError('heygen_family_story_look_incompatible', 'Family Story source must remain the completed owner-selected photo Look.', 409);
    }
  }
  validateHeyGenAvatarVideoCompatibility(input, look);

  const groupResponse = await requiredGet(`/v3/avatars/${look.groupId}`, accessToken, deps);
  if (!groupResponse.ok) throw groupResponse;
  const group = parseHeyGenAvatarGroup(groupResponse.body);
  if (group.id !== look.groupId) {
    throw brokerError('heygen_avatar_group_lookup_mismatch', 'HeyGen returned the wrong avatar group.', 502);
  }
  if (group.status !== 'completed') {
    throw brokerError(
      'heygen_avatar_group_not_ready',
      `HeyGen avatar group is not completed (${group.status ?? 'missing'}).`,
      409,
    );
  }
  if (input.familyStoryFounder) {
    const profile = HEYGEN_FAMILY_STORY_PROFILES[input.familyStoryFounder];
    if (group.id !== profile.groupId || !isHeyGenConsentAccepted(group.consentStatus)) {
      throw brokerError(
        'heygen_family_story_consent_required',
        'Family Story founder group must have explicit accepted/completed consent before any dry run or render.',
        409,
      );
    }
  } else if (!isHeyGenConsentStatusReady(group.consentStatus)) {
    throw brokerError('heygen_avatar_consent_required', 'HeyGen avatar group consent is not approved.', 409);
  }

  const voiceResponse = await requiredGet(`/v3/voices/${input.voiceId}`, accessToken, deps);
  if (!voiceResponse.ok) throw voiceResponse;
  const voice = parseHeyGenVoice(voiceResponse.body);
  if (voice.voiceId !== input.voiceId) {
    throw brokerError('heygen_voice_lookup_mismatch', 'HeyGen returned the wrong voice.', 502);
  }
  if (voice.status === 'processing' || voice.status === 'failed') {
    throw brokerError('heygen_voice_not_ready', `HeyGen voice is not ready (${voice.status}).`, 409);
  }
  if (input.familyStoryFounder && parseHeyGenBreakSeconds(input.script) > 0 && voice.supportPause !== true) {
    throw brokerError(
      'heygen_family_story_pause_unsupported',
      'Family Story script contains pause tags, but the exact founder voice does not explicitly advertise support_pause=true.',
      409,
    );
  }

  let referenceLook: HeyGenAvatarLook | undefined;
  if (input.referenceLookId) {
    const referenceResponse = await requiredGet(`/v3/avatars/looks/${input.referenceLookId}`, accessToken, deps);
    if (!referenceResponse.ok) throw referenceResponse;
    referenceLook = parseHeyGenAvatarLook(referenceResponse.body);
    if (
      referenceLook.id !== input.referenceLookId ||
      referenceLook.avatarType !== 'digital_twin' ||
      referenceLook.groupId !== look.groupId ||
      !referenceLook.supportedApiEngines.includes('avatar_v') ||
      referenceLook.status !== 'completed'
    ) {
      throw brokerError(
        'heygen_reference_look_incompatible',
        'Avatar V reference_look_id must be a completed, Avatar V-eligible Digital Twin look in the same avatar group.',
        409,
      );
    }
  }
  return {
    account: accountResponse.body,
    billing,
    plan: snapshot.plan,
    credits: snapshot.remaining,
    look,
    group,
    voice,
    referenceLook,
  };
}

export async function prepareHeyGenAvatarVideoCreate(
  input: HeyGenAvatarVideoCreateInput,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<{
  plan: HeyGenAvatarVideoPlan;
  billing: ReturnType<typeof parseHeyGenBillingSnapshot>;
  look: HeyGenAvatarLook;
  group: HeyGenAvatarGroup;
  voice: HeyGenVoice;
  referenceLook?: HeyGenAvatarLook;
}> {
  let plan: HeyGenAvatarVideoPlan;
  try {
    plan = buildHeyGenAvatarVideoPlan(input);
  } catch (error) {
    throw brokerError('heygen_video_input_invalid', (error as Error).message, 400);
  }
  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await getHeyGenAccessToken({
      forceRefresh: attempt === 1,
      rejectedAccessToken,
      deps,
    });
    try {
      const preflight = await runVideoPreflight(input, accessToken, deps);
      return {
        plan,
        billing: preflight.billing,
        look: preflight.look,
        group: preflight.group,
        voice: preflight.voice,
        referenceLook: preflight.referenceLook,
      };
    } catch (error) {
      if (isRawResponse(error) && error.status === 401 && attempt === 0) {
        rejectedAccessToken = accessToken;
        continue;
      }
      throw error;
    }
  }
  throw brokerError('heygen_auth_failed', 'HeyGen OAuth authorization failed after one refresh retry.', 401);
}

function isRawResponse(value: unknown): value is HeyGenRawResponse {
  return Boolean(value && typeof value === 'object' && typeof (value as HeyGenRawResponse).status === 'number');
}

async function claimVideoSubmission(
  operation: { doc: HeyGenVideoOperationDoc; etag: string },
  planName: string,
  creditsBefore: number,
  deps: HeyGenBrokerDeps,
): Promise<{
  claimed: { doc: HeyGenVideoOperationDoc; etag: string } | null;
  view?: HeyGenAvatarVideoCreateResult;
}> {
  if (operation.doc.state === 'accepted' || operation.doc.state === 'rejected') {
    return { claimed: null, view: operationView(operation.doc, true, deps.now()) };
  }
  if (
    operation.doc.state === 'submitting' &&
    operation.doc.leaseExpiresAt &&
    Date.parse(operation.doc.leaseExpiresAt) > deps.now()
  ) {
    return { claimed: null, view: operationView(operation.doc, true, deps.now()) };
  }
  if (
    operation.doc.providerWindowExpiresAt &&
    Date.parse(operation.doc.providerWindowExpiresAt) <= deps.now() &&
    !operation.doc.videoId
  ) {
    throw brokerError(
      'heygen_video_idempotency_window_expired',
      'The provider idempotency window expired before a video_id was recovered. Use a new operation only after manual reconciliation and approval.',
      409,
    );
  }
  const firstSubmittedAt = operation.doc.firstSubmittedAt ?? new Date(deps.now()).toISOString();
  const claimed = await replaceVideoOperation(
    operation,
    {
      state: 'submitting',
      attemptCount: operation.doc.attemptCount + 1,
      plan: planName,
      premiumCreditsBefore: creditsBefore,
      firstSubmittedAt,
      providerWindowExpiresAt:
        operation.doc.providerWindowExpiresAt ?? new Date(deps.now() + HEYGEN_IDEMPOTENCY_WINDOW_MS).toISOString(),
      leaseExpiresAt: new Date(deps.now() + HEYGEN_VIDEO_SUBMIT_LEASE_MS).toISOString(),
      lastErrorCode: undefined,
    },
    deps,
  );
  if (claimed) return { claimed };
  const winner = await readVideoOperation(operation.doc.operationId, deps);
  if (!winner) {
    throw brokerError('heygen_video_operation_store_unavailable', 'Could not reconcile the HeyGen video operation.');
  }
  return { claimed: null, view: operationView(winner.doc, true, deps.now()) };
}

export async function getHeyGenVideoOperation(
  operationId: string,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenAvatarVideoCreateResult | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) {
    throw brokerError('heygen_operation_id_invalid', 'operation_id is invalid.', 400);
  }
  const row = await readVideoOperation(operationId, deps);
  return row ? operationView(row.doc, true, deps.now()) : null;
}

/** Safe terminal replay for the create surface: validates the complete request envelope before reuse. */
export async function getHeyGenVideoTerminalReplay(
  input: HeyGenAvatarVideoCreateInput,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenAvatarVideoCreateResult | null> {
  const row = await readVideoOperation(input.operationId, deps);
  if (!row || (row.doc.state !== 'accepted' && row.doc.state !== 'rejected')) return null;
  let plan: HeyGenAvatarVideoPlan;
  try {
    plan = buildHeyGenAvatarVideoPlan(input, {
      legacyTerminalReplay: row.doc.version === 1,
    });
  } catch (error) {
    throw brokerError('heygen_video_input_invalid', (error as Error).message, 400);
  }
  assertSameTerminalReplay(row.doc, input, plan);
  return operationView(row.doc, true, deps.now());
}

export async function executeHeyGenAvatarVideoCreate(
  input: HeyGenAvatarVideoCreateInput,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenAvatarVideoCreateResult> {
  const existingTerminal = await readVideoOperation(input.operationId, deps);
  let plan: HeyGenAvatarVideoPlan;
  try {
    plan = buildHeyGenAvatarVideoPlan(input, {
      legacyTerminalReplay:
        existingTerminal?.doc.version === 1 &&
        (existingTerminal.doc.state === 'accepted' || existingTerminal.doc.state === 'rejected'),
    });
  } catch (error) {
    throw brokerError('heygen_video_input_invalid', (error as Error).message, 400);
  }
  if (existingTerminal && (existingTerminal.doc.state === 'accepted' || existingTerminal.doc.state === 'rejected')) {
    assertSameTerminalReplay(existingTerminal.doc, input, plan);
    return operationView(existingTerminal.doc, true, deps.now());
  }
  if (
    !input.confirmedBillingSnapshotSha256 ||
    !input.confirmedBillingStateSha256 ||
    !input.confirmedBillingObservedAt ||
    !input.ownerApprovalJws
  ) {
    throw brokerError(
      'heygen_video_owner_approval_required',
      'Real Avatar Video creation requires the exact dry-run billing snapshot/state/time plus a short-lived owner approval captured through the configured approval broker.',
      400,
    );
  }
  const observedAt = Date.parse(input.confirmedBillingObservedAt);
  if (!Number.isFinite(observedAt) || deps.now() - observedAt > 10 * 60_000 || observedAt > deps.now() + 30_000) {
    throw brokerError('heygen_video_billing_snapshot_stale', 'The approved billing snapshot is stale or from the future. Run a new dry-run.', 409);
  }
  const operation = await ensureVideoOperation(input, plan, deps);
  if (operation.doc.state === 'accepted' || operation.doc.state === 'rejected') {
    return operationView(operation.doc, true, deps.now());
  }

  let rejectedAccessToken: string | undefined;
  let claimed: { doc: HeyGenVideoOperationDoc; etag: string } | null = null;
  let spendReservation: HeyGenSpendReservation | null = null;
  for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
    const accessToken = await getHeyGenAccessToken({
      forceRefresh: authAttempt === 1,
      rejectedAccessToken,
      deps,
    });
    let preflight: Awaited<ReturnType<typeof runVideoPreflight>>;
    try {
      preflight = await runVideoPreflight(input, accessToken, deps);
    } catch (error) {
      if (isRawResponse(error) && error.status === 401 && authAttempt === 0) {
        rejectedAccessToken = accessToken;
        continue;
      }
      if (isRawResponse(error)) {
        throw brokerError(
          'heygen_video_preflight_failed',
          `HeyGen video preflight failed (HTTP ${error.status}). No video was submitted.`,
          error.status === 401 ? 401 : 409,
        );
      }
      throw error;
    }

    const firstSubmission = !operation.doc.firstSubmittedAt;
    if (firstSubmission && preflight.credits !== input.confirmedPremiumCreditsBefore) {
      throw brokerError(
        'heygen_credit_snapshot_mismatch',
        `HeyGen premium-credit balance changed: confirmed ${input.confirmedPremiumCreditsBefore}, current ${preflight.credits}. Reconfirm before submission.`,
        409,
      );
    }
    if (preflight.billing.state_sha256 !== input.confirmedBillingStateSha256) {
      throw brokerError(
        'heygen_video_billing_state_mismatch',
        'HeyGen account, plan, credit pools, or reset windows changed after approval. Run a new dry-run.',
        409,
      );
    }
    if (preflight.credits - input.maxApprovedCredits < input.reservePremiumCredits) {
      throw brokerError(
        'heygen_video_credit_reserve_violation',
        'The approved credit ceiling would reduce the live balance below the reserve floor. No video was submitted.',
        409,
      );
    }
    const approval = verifyHeyGenAvatarVideoApproval(input.ownerApprovalJws, {
      operationId: input.operationId,
      requestSha256: plan.requestSha256,
      idempotencyKeySha256: plan.idempotencyKeySha256,
      manifestSha256: input.manifestSha256,
      billingSnapshotSha256: input.confirmedBillingSnapshotSha256,
      billingStateSha256: input.confirmedBillingStateSha256,
      billingObservedAt: input.confirmedBillingObservedAt,
      confirmedPremiumCreditsBefore: input.confirmedPremiumCreditsBefore,
      reserveCredits: input.reservePremiumCredits,
      maxCredits: input.maxApprovedCredits,
    }, deps.now());
    spendReservation = await reserveHeyGenSpend({
      accountId: preflight.billing.account_id,
      operationId: input.operationId,
      kind: 'avatar_video',
      maxCredits: input.maxApprovedCredits,
      reserveCredits: input.reservePremiumCredits,
      premiumCreditsBefore: preflight.credits,
      billingStateSha256: preflight.billing.state_sha256,
    }, deps);

    if (!claimed) {
      try {
        const claim = await claimVideoSubmission(operation, preflight.plan, preflight.credits, deps);
        if (claim.view) return claim.view;
        claimed = claim.claimed!;
      } catch (error) {
        if (spendReservation) await settleHeyGenSpend(spendReservation, 'rejected', deps).catch(() => undefined);
        throw error;
      }
    }

    let consumed;
    try {
      consumed = await consumeHeyGenOwnerApproval(approval, deps);
    } catch {
      const rejected = await replaceVideoOperation(claimed, {
        state: 'rejected',
        lastErrorCode: 'owner_approval_replay_or_fence_failure',
        leaseExpiresAt: undefined,
      }, deps);
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'rejected', deps);
      return operationView((rejected ?? claimed).doc, false, deps.now());
    }
    const granted = await replaceVideoOperation(claimed, {
      grantIdSha256: consumed.grant_id_sha256,
      billingBeforeSha256: preflight.billing.snapshot_sha256,
    }, deps);
    if (!granted) {
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'rejected', deps);
      const winner = await readVideoOperation(input.operationId, deps);
      if (winner) return operationView(winner.doc, true, deps.now());
      throw brokerError('heygen_video_operation_store_unavailable', 'Could not persist the consumed owner grant. No video request was sent.');
    }
    claimed = granted;

    let response: HeyGenRawResponse | null = null;
    try {
      response = await heyGenApiPost(
        '/v3/videos',
        accessToken,
        plan.body,
        deps,
        { 'Idempotency-Key': input.idempotencyKey },
      );
    } catch {
      response = null;
    }
    const code = response ? providerErrorCode(response.body) : undefined;
    if (response?.status === 409 && code === 'request_in_progress') {
      const updated = await replaceVideoOperation(
        claimed,
        { state: 'submitting', upstreamStatus: 409, lastErrorCode: code },
        deps,
      );
      return operationView((updated ?? claimed).doc, true, deps.now());
    }
    if (!response || response.status === 401 || response.status >= 500) {
      const updated = await replaceVideoOperation(
        claimed,
        {
          state: 'outcome_unknown',
          upstreamStatus: response?.status,
          lastErrorCode: code ?? (response?.status ? `http_${response.status}` : 'outcome_unknown'),
          leaseExpiresAt: undefined,
        },
        deps,
      );
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'outcome_unknown', deps);
      return operationView((updated ?? claimed).doc, false, deps.now());
    }
    if (!response.ok) {
      const updated = await replaceVideoOperation(
        claimed,
        {
          state: 'rejected',
          upstreamStatus: response.status,
          lastErrorCode: code ?? `http_${response.status}`,
          leaseExpiresAt: undefined,
        },
        deps,
      );
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'rejected', deps);
      return operationView((updated ?? claimed).doc, false, deps.now());
    }

    let accepted: { videoId: string; status: string };
    try {
      accepted = parseHeyGenCreateVideo(response.body);
    } catch {
      const updated = await replaceVideoOperation(
        claimed,
        {
          state: 'outcome_unknown',
          upstreamStatus: response.status,
          lastErrorCode: 'invalid_success',
          leaseExpiresAt: undefined,
        },
        deps,
      );
      if (spendReservation) await settleHeyGenSpend(spendReservation, 'outcome_unknown', deps);
      return operationView((updated ?? claimed).doc, false, deps.now());
    }

    let billingAfter;
    try {
      const accountAfter = await heyGenApiGet('/v3/users/me', accessToken, {}, deps);
      if (accountAfter.ok) {
        billingAfter = parseHeyGenBillingSnapshot(accountAfter.body, new Date(deps.now()).toISOString());
      }
    } catch {
      billingAfter = undefined;
    }
    const premiumAfter = billingAfter?.premium.remaining ?? undefined;
    const actualCreditDelta = premiumAfter === undefined ? undefined : preflight.credits - premiumAfter;
    const unexpectedDelta = actualCreditDelta !== undefined && actualCreditDelta > input.maxApprovedCredits;
    const creditReconciliationFailed = actualCreditDelta === undefined || unexpectedDelta;
    const updated = await replaceVideoOperation(
      claimed,
      {
        state: 'accepted',
        videoId: accepted.videoId,
        providerStatus: accepted.status,
        upstreamStatus: response.status,
        premiumCreditsAfter: premiumAfter,
        actualCreditDelta,
        billingAfterSha256: billingAfter?.snapshot_sha256,
        lastErrorCode: unexpectedDelta
          ? 'unexpected_credit_delta'
          : actualCreditDelta === undefined
            ? 'credit_delta_unverified'
            : undefined,
        leaseExpiresAt: undefined,
      },
      deps,
    );
    if (updated) {
      if (spendReservation) {
        await settleHeyGenSpend(
          spendReservation,
          creditReconciliationFailed ? 'outcome_unknown' : 'accepted',
          deps,
        );
      }
      return operationView(updated.doc, false, deps.now());
    }
    const winner = await readVideoOperation(input.operationId, deps);
    if (winner?.doc.state === 'accepted') {
      if (spendReservation) {
        await settleHeyGenSpend(
          spendReservation,
          creditReconciliationFailed ? 'outcome_unknown' : 'accepted',
          deps,
        );
      }
      return operationView(winner.doc, true, deps.now());
    }
    if (spendReservation) await settleHeyGenSpend(spendReservation, 'outcome_unknown', deps);
    return operationView(
      {
        ...claimed.doc,
        state: 'outcome_unknown',
        lastErrorCode: 'accepted_response_persist_race',
        leaseExpiresAt: undefined,
      },
      true,
      deps.now(),
    );
  }
  throw brokerError('heygen_auth_failed', 'HeyGen OAuth authorization failed after one refresh retry.', 401);
}

export async function getHeyGenVideoDetail(
  videoId: string,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenVideoDetail> {
  const raw = await executeHeyGenRead({ kind: 'video', videoId }, deps);
  try {
    return parseHeyGenVideoDetail(raw);
  } catch {
    throw brokerError('heygen_video_response_invalid', 'HeyGen returned an invalid video record.', 502);
  }
}
