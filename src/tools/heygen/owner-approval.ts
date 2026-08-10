import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import { loadEnv } from '../../config/env.js';
import type { HeyGenBrokerDeps } from './broker.js';

const CACHE_CONTAINER = 'cache';
const MAX_GRANT_AGE_SECONDS = 10 * 60;

const HeaderSchema = z.object({
  alg: z.literal('ES256'),
  typ: z.literal('OTC-HeyGen-Approval+jwt'),
  kid: z.string().min(1).max(128),
}).strict();

const BaseClaims = {
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().regex(/^[A-Za-z0-9_.:-]{8,255}$/),
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  billing_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  billing_state_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  billing_observed_at: z.string().min(1),
  confirmed_premium_credits_before: z.number().int().nonnegative(),
  reserve_credits: z.number().int().nonnegative(),
} as const;

const ReferenceLookClaimsSchema = z.object({
  ...BaseClaims,
  grant_type: z.literal('heygen_reference_look_create'),
  tool: z.literal('heygen_reference_look_create'),
  max_credits: z.literal(1),
}).strict();

const AvatarVideoClaimsSchema = z.object({
  ...BaseClaims,
  grant_type: z.literal('heygen_avatar_video_create'),
  tool: z.literal('heygen_avatar_video_create'),
  idempotency_key_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  max_credits: z.number().int().min(1),
}).strict();

const ClaimsSchema = z.discriminatedUnion('grant_type', [ReferenceLookClaimsSchema, AvatarVideoClaimsSchema]);

export type HeyGenOwnerApprovalClaims = z.infer<typeof ClaimsSchema>;

function base64urlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('approval grant contains invalid base64url.');
  return Buffer.from(value, 'base64url');
}

function parseJsonSegment(value: string, label: string): unknown {
  try {
    const decoded = base64urlDecode(value);
    if (decoded.length > 16_384) throw new Error('oversized');
    return JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error(`approval grant ${label} is invalid.`);
  }
}

export interface HeyGenApprovalVerificationConfig {
  issuer: string;
  audience: string;
  subject: string;
  jwk: JsonWebKey;
}

function approvalConfig(override?: HeyGenApprovalVerificationConfig): HeyGenApprovalVerificationConfig {
  if (override) return override;
  const env = loadEnv();
  if (!env.HEYGEN_OWNER_APPROVAL_SUBJECT || !env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK) {
    throw new Error('HeyGen owner approval verification is not configured.');
  }
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK) as JsonWebKey;
  } catch {
    throw new Error('HeyGen owner approval public key is invalid.');
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || !jwk.kid) {
    throw new Error('HeyGen owner approval key must be a named P-256 public JWK.');
  }
  return {
    issuer: env.HEYGEN_OWNER_APPROVAL_ISSUER,
    audience: env.HEYGEN_OWNER_APPROVAL_AUDIENCE,
    subject: env.HEYGEN_OWNER_APPROVAL_SUBJECT,
    jwk,
  };
}

function verifyApproval(
  compactJws: string,
  expected: {
    grantType: HeyGenOwnerApprovalClaims['grant_type'];
    operationId: string;
    requestSha256: string;
    idempotencyKeySha256?: string;
    manifestSha256?: string;
    billingSnapshotSha256: string;
    billingStateSha256: string;
    billingObservedAt: string;
    confirmedPremiumCreditsBefore: number;
    reserveCredits: number;
    maxCredits: number;
  },
  nowMs: number,
  configOverride?: HeyGenApprovalVerificationConfig,
): HeyGenOwnerApprovalClaims {
  if (typeof compactJws !== 'string' || compactJws.length < 64 || compactJws.length > 8192) {
    throw new Error('owner_approval_jws is invalid.');
  }
  const parts = compactJws.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error('owner_approval_jws is invalid.');
  const [protectedPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = HeaderSchema.parse(parseJsonSegment(protectedPart, 'header'));
  const claims = ClaimsSchema.parse(parseJsonSegment(payloadPart, 'claims'));
  const config = approvalConfig(configOverride);
  if (header.kid !== config.jwk.kid) throw new Error('owner approval key id is not trusted.');
  const key = createPublicKey({ key: config.jwk, format: 'jwk' });
  const signature = base64urlDecode(signaturePart);
  if (signature.length !== 64) throw new Error('owner approval signature is invalid.');
  const valid = verify(
    'sha256',
    Buffer.from(`${protectedPart}.${payloadPart}`, 'ascii'),
    { key, dsaEncoding: 'ieee-p1363' },
    signature,
  );
  if (!valid) throw new Error('owner approval signature is invalid.');

  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== config.issuer || claims.aud !== config.audience || claims.sub !== config.subject) {
    throw new Error('owner approval principal or audience mismatch.');
  }
  if (claims.iat > now + 30 || claims.nbf > now + 30 || claims.exp <= now - 30) {
    throw new Error('owner approval is outside its valid time window.');
  }
  if (claims.exp - claims.iat > MAX_GRANT_AGE_SECONDS || claims.exp <= claims.iat) {
    throw new Error('owner approval lifetime is invalid.');
  }
  const avatarBindingMismatch =
    expected.grantType === 'heygen_avatar_video_create' &&
    (
      claims.grant_type !== 'heygen_avatar_video_create' ||
      claims.idempotency_key_sha256 !== expected.idempotencyKeySha256 ||
      claims.manifest_sha256 !== expected.manifestSha256
    );
  if (
    avatarBindingMismatch ||
    claims.grant_type !== expected.grantType ||
    claims.tool !== expected.grantType ||
    claims.operation_id !== expected.operationId ||
    claims.request_sha256 !== expected.requestSha256 ||
    claims.billing_snapshot_sha256 !== expected.billingSnapshotSha256 ||
    claims.billing_state_sha256 !== expected.billingStateSha256 ||
    claims.billing_observed_at !== expected.billingObservedAt ||
    claims.confirmed_premium_credits_before !== expected.confirmedPremiumCreditsBefore ||
    claims.reserve_credits !== expected.reserveCredits ||
    claims.max_credits !== expected.maxCredits
  ) {
    throw new Error('owner approval is bound to a different operation, request, idempotency key, manifest, billing snapshot, or credit ceiling.');
  }
  return claims;
}

export function verifyHeyGenReferenceLookApproval(
  compactJws: string,
  expected: {
    operationId: string;
    requestSha256: string;
    billingSnapshotSha256: string;
    billingStateSha256: string;
    billingObservedAt: string;
    confirmedPremiumCreditsBefore: number;
    reserveCredits: number;
  },
  nowMs = Date.now(),
  configOverride?: HeyGenApprovalVerificationConfig,
): HeyGenOwnerApprovalClaims {
  return verifyApproval(compactJws, {
    grantType: 'heygen_reference_look_create',
    operationId: expected.operationId,
    requestSha256: expected.requestSha256,
    billingSnapshotSha256: expected.billingSnapshotSha256,
    billingStateSha256: expected.billingStateSha256,
    billingObservedAt: expected.billingObservedAt,
    confirmedPremiumCreditsBefore: expected.confirmedPremiumCreditsBefore,
    reserveCredits: expected.reserveCredits,
    maxCredits: 1,
  }, nowMs, configOverride);
}

export function verifyHeyGenAvatarVideoApproval(
  compactJws: string,
  expected: {
    operationId: string;
    requestSha256: string;
    idempotencyKeySha256: string;
    manifestSha256: string;
    billingSnapshotSha256: string;
    billingStateSha256: string;
    billingObservedAt: string;
    confirmedPremiumCreditsBefore: number;
    reserveCredits: number;
    maxCredits: number;
  },
  nowMs = Date.now(),
  configOverride?: HeyGenApprovalVerificationConfig,
): HeyGenOwnerApprovalClaims {
  return verifyApproval(compactJws, {
    grantType: 'heygen_avatar_video_create',
    operationId: expected.operationId,
    requestSha256: expected.requestSha256,
    idempotencyKeySha256: expected.idempotencyKeySha256,
    manifestSha256: expected.manifestSha256,
    billingSnapshotSha256: expected.billingSnapshotSha256,
    billingStateSha256: expected.billingStateSha256,
    billingObservedAt: expected.billingObservedAt,
    confirmedPremiumCreditsBefore: expected.confirmedPremiumCreditsBefore,
    reserveCredits: expected.reserveCredits,
    maxCredits: expected.maxCredits,
  }, nowMs, configOverride);
}

export function heyGenApprovalJtiSha256(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

export async function consumeHeyGenOwnerApproval(
  claims: HeyGenOwnerApprovalClaims,
  deps: Pick<HeyGenBrokerDeps, 'create' | 'now'>,
): Promise<{ grant_id_sha256: string }> {
  const hash = heyGenApprovalJtiSha256(claims.jti);
  const id = `heygen.approval.${hash}`;
  const nowSeconds = Math.floor(deps.now() / 1000);
  const doc = {
    id,
    cacheScope: id,
    kind: 'heygen_owner_approval_consumption',
    version: 1,
    ttl: Math.max(60, claims.exp - nowSeconds + 60),
    grantIdSha256: hash,
    grantType: claims.grant_type,
    tool: claims.tool,
    operationId: claims.operation_id,
    requestSha256: claims.request_sha256,
    idempotencyKeySha256:
      claims.grant_type === 'heygen_avatar_video_create' ? claims.idempotency_key_sha256 : undefined,
    manifestSha256:
      claims.grant_type === 'heygen_avatar_video_create' ? claims.manifest_sha256 : undefined,
    billingSnapshotSha256: claims.billing_snapshot_sha256,
    billingStateSha256: claims.billing_state_sha256,
    billingObservedAt: claims.billing_observed_at,
    confirmedPremiumCreditsBefore: claims.confirmed_premium_credits_before,
    reserveCredits: claims.reserve_credits,
    maxCredits: claims.max_credits,
    consumedAt: new Date(deps.now()).toISOString(),
  };
  try {
    await deps.create(CACHE_CONTAINER, id, doc);
  } catch {
    throw new Error('owner approval was already consumed or could not be fenced.');
  }
  return { grant_id_sha256: hash };
}
