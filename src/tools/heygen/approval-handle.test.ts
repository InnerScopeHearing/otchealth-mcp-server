import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptHeyGenOwnerApprovalHandle, encryptHeyGenOwnerApprovalHandle } from './approval-handle.js';

const SECRET = 'handle-secret-with-at-least-thirty-two-bytes';
const NOW = 1_800_000_000_000;
const JWS = `${'a'.repeat(64)}.${'b'.repeat(64)}.${'c'.repeat(64)}`;

function fixedRandom(size: number): Buffer {
  return Buffer.alloc(size, 7);
}

test('approval handle encrypts the raw owner JWS and binds operation/expiry', () => {
  const handle = encryptHeyGenOwnerApprovalHandle({
    operationId: 'video_op_01', ownerApprovalJws: JWS, expiresAt: Math.floor(NOW / 1000) + 300,
  }, SECRET, fixedRandom);
  assert.ok(!handle.includes(JWS));
  assert.equal(decryptHeyGenOwnerApprovalHandle(handle, 'video_op_01', SECRET, NOW), JWS);
  assert.throws(() => decryptHeyGenOwnerApprovalHandle(handle, 'video_op_02', SECRET, NOW), /different operation/);
  assert.throws(() => decryptHeyGenOwnerApprovalHandle(handle, 'video_op_01', SECRET, NOW + 400_000), /expired/);
});

test('approval handle rejects tampering and a different key', () => {
  const handle = encryptHeyGenOwnerApprovalHandle({
    operationId: 'video_op_01', ownerApprovalJws: JWS, expiresAt: Math.floor(NOW / 1000) + 300,
  }, SECRET, fixedRandom);
  const parts = handle.split('.');
  parts[2] = `${parts[2]!.slice(0, -1)}A`;
  assert.throws(() => decryptHeyGenOwnerApprovalHandle(parts.join('.'), 'video_op_01', SECRET, NOW), /authentication failed/);
  assert.throws(() => decryptHeyGenOwnerApprovalHandle(handle, 'video_op_01', 'different-secret-with-at-least-thirty-two-bytes', NOW), /authentication failed/);
});
