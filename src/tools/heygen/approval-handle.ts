import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

const AAD = Buffer.from('otchealth.heygen.owner-approval-handle.v1', 'utf8');
const PayloadSchema = z.object({
  version: z.literal(1),
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  owner_approval_jws: z.string().min(64).max(8192),
  expires_at: z.number().int().positive(),
}).strict();

function key(secret: string): Buffer {
  if (secret.length < 32) throw new Error('HeyGen approval handle secret is not configured.');
  return createHash('sha256').update('heygen-approval-handle-key-v1\0').update(secret).digest();
}

export function encryptHeyGenOwnerApprovalHandle(
  input: { operationId: string; ownerApprovalJws: string; expiresAt: number },
  secret: string,
  random: (size: number) => Buffer = randomBytes,
): string {
  const payload = PayloadSchema.parse({
    version: 1,
    operation_id: input.operationId,
    owner_approval_jws: input.ownerApprovalJws,
    expires_at: input.expiresAt,
  });
  const iv = random(12);
  if (iv.length !== 12) throw new Error('Approval handle IV generator returned the wrong size.');
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `h1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptHeyGenOwnerApprovalHandle(
  handle: string,
  expectedOperationId: string,
  secret: string,
  nowMs = Date.now(),
): string {
  if (typeof handle !== 'string' || handle.length < 100 || handle.length > 16_384) {
    throw new Error('owner_approval_handle is invalid.');
  }
  const parts = handle.split('.');
  if (parts.length !== 4 || parts[0] !== 'h1' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('owner_approval_handle is invalid.');
  }
  const iv = Buffer.from(parts[1]!, 'base64url');
  const ciphertext = Buffer.from(parts[2]!, 'base64url');
  const tag = Buffer.from(parts[3]!, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error('owner_approval_handle is invalid.');
  let clear: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secret), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('owner_approval_handle authentication failed.');
  }
  let payload: z.infer<typeof PayloadSchema>;
  try {
    payload = PayloadSchema.parse(JSON.parse(clear.toString('utf8')));
  } catch {
    throw new Error('owner_approval_handle payload is invalid.');
  }
  if (payload.operation_id !== expectedOperationId) throw new Error('owner_approval_handle belongs to a different operation.');
  if (payload.expires_at <= Math.floor(nowMs / 1000) - 30) throw new Error('owner_approval_handle is expired.');
  return payload.owner_approval_jws;
}
