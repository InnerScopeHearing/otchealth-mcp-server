import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createDoc, readDoc } from '../../agentstate/cosmos.js';

const CACHE = 'cache';
const ApprovalDocSchema = z.object({
  id: z.string().min(1),
  cacheScope: z.string().min(1),
  ttl: z.number().int().positive(),
  kind: z.literal('heygen_owner_approval_handle'),
  version: z.literal(1),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  packetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  encryptedHandle: z.string().min(100).max(16_384),
  ownerSubjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).passthrough();

export type HeyGenOwnerApprovalHandleDoc = z.infer<typeof ApprovalDocSchema>;

export interface HeyGenApprovalStoreDeps {
  create: typeof createDoc;
  read: typeof readDoc;
  now: () => number;
}

export const defaultHeyGenApprovalStoreDeps: HeyGenApprovalStoreDeps = {
  create: createDoc,
  read: readDoc,
  now: () => Date.now(),
};

function docId(operationId: string): string {
  return `heygen.owner-approval.${operationId}`;
}

export async function storeHeyGenOwnerApprovalHandle(
  input: {
    operationId: string;
    packetSha256: string;
    encryptedHandle: string;
    ownerSubject: string;
    expiresAt: string;
  },
  deps: HeyGenApprovalStoreDeps = defaultHeyGenApprovalStoreDeps,
): Promise<void> {
  const id = docId(input.operationId);
  const now = deps.now();
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs - now > 10 * 60_000 + 30_000) {
    throw new Error('Owner approval handle expiry is invalid.');
  }
  const doc: HeyGenOwnerApprovalHandleDoc = {
    id,
    cacheScope: id,
    ttl: Math.max(60, Math.ceil((expiresAtMs - now) / 1000) + 60),
    kind: 'heygen_owner_approval_handle',
    version: 1,
    operationId: input.operationId,
    packetSha256: input.packetSha256,
    encryptedHandle: input.encryptedHandle,
    ownerSubjectSha256: createHash('sha256').update(input.ownerSubject, 'utf8').digest('hex'),
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  try {
    await deps.create(CACHE, id, doc);
  } catch {
    throw new Error('Owner approval for this operation already exists or could not be persisted.');
  }
}

export async function readHeyGenOwnerApprovalHandle(
  operationId: string,
  deps: HeyGenApprovalStoreDeps = defaultHeyGenApprovalStoreDeps,
): Promise<{ encryptedHandle: string; packetSha256: string; expiresAt: string } | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId)) throw new Error('operation_id is invalid.');
  const id = docId(operationId);
  const row = await deps.read(CACHE, id, id);
  if (!row) return null;
  const doc = ApprovalDocSchema.parse(row.doc);
  if (Date.parse(doc.expiresAt) <= deps.now() - 30_000) return null;
  return { encryptedHandle: doc.encryptedHandle, packetSha256: doc.packetSha256, expiresAt: doc.expiresAt };
}
