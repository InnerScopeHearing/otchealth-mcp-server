import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHeyGenOwnerApprovalHandle, storeHeyGenOwnerApprovalHandle, type HeyGenApprovalStoreDeps } from './approval-store.js';

const NOW = 1_800_000_000_000;

test('approval store persists only encrypted handle and bounded hashes, never JWS/email', async () => {
  let stored: Record<string, unknown> | null = null;
  const deps: HeyGenApprovalStoreDeps = {
    now: () => NOW,
    create: (async (_coll, pk, doc) => {
      assert.equal(pk, doc.id);
      stored = doc;
      return { ok: true, status: 201, body: doc, etag: 'E1' };
    }) as HeyGenApprovalStoreDeps['create'],
    read: (async () => stored ? { doc: stored, etag: 'E1' } : null) as HeyGenApprovalStoreDeps['read'],
  };
  await storeHeyGenOwnerApprovalHandle({
    operationId: 'video_op_01', packetSha256: 'a'.repeat(64), encryptedHandle: 'h'.repeat(120),
    ownerSubject: 'matthew@otchealthmart.com', expiresAt: new Date(NOW + 300_000).toISOString(),
  }, deps);
  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes('matthew@otchealthmart.com'));
  assert.ok(!serialized.includes('owner_approval_jws'));
  assert.match(String(stored!['ownerSubjectSha256']), /^[a-f0-9]{64}$/);
  const read = await readHeyGenOwnerApprovalHandle('video_op_01', deps);
  assert.equal(read?.packetSha256, 'a'.repeat(64));
});
