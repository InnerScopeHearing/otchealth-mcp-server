import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalize, canonicalJsonSha256 } from './video-contracts.js';

export const HeyGenAvatarVideoApprovalPacketSchema = z.object({
  grant_type: z.literal('heygen_avatar_video_create'),
  tool: z.literal('heygen_avatar_video_create'),
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotency_key_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  billing_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  billing_state_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  billing_observed_at: z.string().datetime(),
  confirmed_premium_credits_before: z.number().int().nonnegative(),
  reserve_credits: z.number().int().nonnegative(),
  max_credits: z.number().int().min(1),
  conservative_credit_cap: z.number().int().min(1),
  provider_credit_cap_available: z.literal(false),
  gateway_pre_submission_cap_enforced: z.literal(true),
  post_call_overage_locks_account: z.literal(true),
  family_story_exact_cap_required: z.boolean(),
  owner_grant_required: z.literal(true),
  zero_automatic_retries: z.literal(true),
}).strict();

export type HeyGenAvatarVideoApprovalPacket = z.infer<typeof HeyGenAvatarVideoApprovalPacketSchema>;

const ContextEnvelopeSchema = z.object({
  version: z.literal(1),
  packet: HeyGenAvatarVideoApprovalPacketSchema,
  packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
}).strict();

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'ascii').digest();
}

export function createHeyGenApprovalContextToken(
  packetValue: unknown,
  secret: string,
  nowMs = Date.now(),
  ttlSeconds = 10 * 60,
): { token: string; packet: HeyGenAvatarVideoApprovalPacket; packetSha256: string; expiresAt: string } {
  if (secret.length < 32) throw new Error('HeyGen approval context secret is not configured.');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 10 * 60) {
    throw new Error('HeyGen approval context lifetime must be 60-600 seconds.');
  }
  const packet = HeyGenAvatarVideoApprovalPacketSchema.parse(packetValue);
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const packetSha256 = canonicalJsonSha256(packet);
  const envelope = {
    version: 1 as const,
    packet,
    packet_sha256: packetSha256,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const payload = Buffer.from(canonicalize(envelope), 'utf8').toString('base64url');
  const mac = signature(payload, secret).toString('base64url');
  return {
    token: `${payload}.${mac}`,
    packet,
    packetSha256,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export function verifyHeyGenApprovalContextToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): { packet: HeyGenAvatarVideoApprovalPacket; packetSha256: string; expiresAt: string } {
  if (secret.length < 32) throw new Error('HeyGen approval context secret is not configured.');
  if (typeof token !== 'string' || token.length < 100 || token.length > 32_768) {
    throw new Error('HeyGen approval context token is invalid.');
  }
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('HeyGen approval context token is invalid.');
  }
  const [payload, encodedMac] = parts as [string, string];
  const supplied = Buffer.from(encodedMac, 'base64url');
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('HeyGen approval context token signature is invalid.');
  }
  let envelope: z.infer<typeof ContextEnvelopeSchema>;
  try {
    envelope = ContextEnvelopeSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    throw new Error('HeyGen approval context token payload is invalid.');
  }
  const now = Math.floor(nowMs / 1000);
  if (envelope.expires_at <= now - 30 || envelope.issued_at > now + 30 || envelope.expires_at - envelope.issued_at > 10 * 60) {
    throw new Error('HeyGen approval context token is expired or outside its validity window.');
  }
  const packetSha256 = canonicalJsonSha256(envelope.packet);
  if (packetSha256 !== envelope.packet_sha256) throw new Error('HeyGen approval context packet hash mismatch.');
  return {
    packet: envelope.packet,
    packetSha256,
    expiresAt: new Date(envelope.expires_at * 1000).toISOString(),
  };
}
