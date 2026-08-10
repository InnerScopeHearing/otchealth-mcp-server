import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { storeHeyGenOwnerApprovalHandle, type HeyGenApprovalStoreDeps } from '../tools/heygen/approval-store.js';

const CallbackSchema = z.object({
  operation_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  owner_approval_handle: z.string().min(100).max(16_384),
  owner_subject: z.string().min(1).max(320),
  expires_at: z.string().datetime(),
}).strict();

function sameSecret(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || expected.length < 32) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerHeyGenApprovalCallback(
  app: FastifyInstance,
  deps?: HeyGenApprovalStoreDeps,
): void {
  app.post('/heygen/approval/callback', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const env = loadEnv();
    if (!sameSecret(request.headers['x-heygen-approval-callback-secret'], env.HEYGEN_APPROVAL_CALLBACK_SECRET)) {
      return reply.code(401).send({ error: 'approval_callback_unauthorized' });
    }
    const parsed = CallbackSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'approval_callback_invalid' });
    try {
      await storeHeyGenOwnerApprovalHandle({
        operationId: parsed.data.operation_id,
        packetSha256: parsed.data.packet_sha256,
        encryptedHandle: parsed.data.owner_approval_handle,
        ownerSubject: parsed.data.owner_subject,
        expiresAt: parsed.data.expires_at,
      }, deps);
      return reply.code(201).send({ stored: true, operation_id: parsed.data.operation_id });
    } catch (error) {
      return reply.code(409).send({ error: 'approval_callback_conflict', message: (error as Error).message });
    }
  });
}
