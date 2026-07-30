import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkAttachmentPayloadIntegrity } from './tools.js';

/**
 * Regression tests for xero_attachment_upload's truncation/corruption guard (CFO P1-B, 2026-07-30;
 * Copilot review, same date: "no test exercising either an expected_bytes/expected_sha256
 * mismatch or the matching upload path"). Pure-function tests, no network: mismatches must return
 * truncated_payload deterministically, and a genuinely matching payload must pass through clean —
 * BEFORE the handler ever calls Xero.
 */

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

test('checkAttachmentPayloadIntegrity: a byte-length mismatch is caught as truncated_payload', () => {
  const buf = Buffer.from('short content');
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: buf.length + 500 });
  assert.ok(result);
  assert.equal(result.error, 'truncated_payload');
  assert.match(result.reason, /expected_bytes was/);
});

test('checkAttachmentPayloadIntegrity: a sha256 mismatch (same length, different bytes) is caught as truncated_payload', () => {
  const buf = Buffer.from('AAAAAAAAAA'); // 10 bytes
  const differentButSameLength = Buffer.from('BBBBBBBBBB'); // 10 bytes, different hash
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_sha256: sha256Hex(differentButSameLength) });
  assert.ok(result, 'a same-length corruption must still be caught -- this is the whole point of hashing over length alone');
  assert.equal(result.error, 'truncated_payload');
  assert.match(result.reason, /expected_sha256 was/);
});

test('checkAttachmentPayloadIntegrity: expected_sha256 comparison is case-insensitive (uppercase hex input matches)', () => {
  const buf = Buffer.from('case insensitivity check');
  const hash = sha256Hex(buf);
  const result = checkAttachmentPayloadIntegrity(buf, hash, { expected_sha256: hash.toUpperCase() });
  assert.equal(result, null);
});

test('checkAttachmentPayloadIntegrity: matching expected_bytes AND expected_sha256 both pass through as null (no refusal)', () => {
  const buf = Buffer.from('the real, complete, untruncated file content'.repeat(50));
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: buf.length, expected_sha256: sha256Hex(buf) });
  assert.equal(result, null);
});

test('checkAttachmentPayloadIntegrity: neither check requested (both undefined) always passes through as null', () => {
  const buf = Buffer.from('no integrity check requested at all');
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), {});
  assert.equal(result, null);
});

test('checkAttachmentPayloadIntegrity: expected_bytes checked BEFORE expected_sha256 -- a length mismatch is reported even if a caller also passed a wrong hash', () => {
  const buf = Buffer.from('twelve bytes'); // 12 bytes
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: 999, expected_sha256: 'f'.repeat(64) });
  assert.ok(result);
  assert.match(result.reason, /expected_bytes was 999/);
});

test('checkAttachmentPayloadIntegrity: a zero expected_bytes never accidentally passes (0 !== real length) for real content', () => {
  const buf = Buffer.from('non-empty');
  const result = checkAttachmentPayloadIntegrity(buf, sha256Hex(buf), { expected_bytes: 0 });
  assert.ok(result);
});
