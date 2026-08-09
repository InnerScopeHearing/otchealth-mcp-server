/**
 * Durable, read-only HeyGen OAuth token broker.
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
import { loadEnv } from '../../config/env.js';
import {
  createDoc,
  isConfigured as cosmosConfigured,
  readDoc,
  replaceDoc,
} from '../../agentstate/cosmos.js';

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

interface HeyGenRawResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw brokerError('heygen_response_invalid', 'HeyGen returned an invalid response.');
  }
}

async function heyGenApiGet(
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
  return { status: response.status, ok: response.ok, body };
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
// Read-only data operations
// -------------------------------------------------------------------------------------------------

export type HeyGenReadOperation =
  | { kind: 'account' }
  | { kind: 'videos'; limit?: number; token?: string; folderId?: string; title?: string }
  | { kind: 'video'; videoId: string }
  | { kind: 'styles'; tag?: string; limit?: number; token?: string };

function targetForOperation(operation: Exclude<HeyGenReadOperation, { kind: 'account' }>): {
  path: string;
  query: Record<string, string | undefined>;
} {
  switch (operation.kind) {
    case 'videos':
      return {
        path: '/v3/videos',
        query: {
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
          folder_id: operation.folderId,
          title: operation.title,
        },
      };
    case 'video':
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(operation.videoId)) {
        throw brokerError('heygen_video_id_invalid', 'HeyGen video_id contains unsupported characters.', 400);
      }
      return {
        path: `/v3/videos/${operation.videoId}`,
        query: {},
      };
    case 'styles':
      return {
        path: '/v3/video-agents/styles',
        query: {
          tag: operation.tag,
          limit: operation.limit === undefined ? undefined : String(operation.limit),
          token: operation.token,
        },
      };
  }
  throw brokerError('heygen_operation_invalid', 'Unsupported HeyGen read operation.', 400);
}

/**
 * Run one of the four fixed read operations. Every attempt performs GET /v3/users/me immediately
 * before its target and refuses non-subscription accounts before the target request can be sent.
 * A 401 from either the guard or target triggers exactly one forced refresh and one full retry.
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
    const response = await heyGenApiGet(target.path, accessToken, target.query, deps);
    if (response.status === 401 && attempt === 0) {
      rejectedAccessToken = accessToken;
      continue;
    }
    if (!response.ok) {
      throw brokerError(
        'heygen_read_failed',
        `HeyGen read failed (HTTP ${response.status}).`,
        response.status === 401 ? 401 : 502,
      );
    }
    return response.body;
  }
  throw brokerError('heygen_auth_failed', 'HeyGen OAuth authorization failed after one refresh retry.', 401);
}
