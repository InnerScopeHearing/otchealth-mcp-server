import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveSafeWritePath, writeLocalFile, localWriteRoot } from './local-file-write.js';

// Pins the safe-write-path guard: every write is confined to the write root, and a ".." segment is
// refused outright, mirroring xero_get/xero_request's bad_path check for the same class of problem.

test('a plain relative path resolves inside the write root', () => {
  const r = resolveSafeWritePath('some/file.txt');
  assert.equal(r.ok, true);
  assert.equal(r.abs, path.resolve(localWriteRoot(), 'some/file.txt'));
});

test('SAFETY-CRITICAL: a ".." segment is refused, even nested deep', () => {
  for (const bad of ['../escape.txt', 'a/../../escape.txt', '..', 'a/b/../../../etc/passwd']) {
    const r = resolveSafeWritePath(bad);
    assert.equal(r.ok, false, `expected refusal for "${bad}"`);
    assert.equal(r.reason, 'bad_path');
  }
});

test('an absolute path outside the write root is refused even without a literal ".."', () => {
  const r = resolveSafeWritePath('/etc/passwd');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outside_write_root');
});

test('an empty or non-string path is refused', () => {
  assert.equal(resolveSafeWritePath('').ok, false);
  // @ts-expect-error deliberately wrong type to prove the runtime guard, not just the type system
  assert.equal(resolveSafeWritePath(undefined).ok, false);
});

test('writeLocalFile writes the bytes and returns a correct sha256', async () => {
  const crypto = await import('node:crypto');
  const content = Buffer.from('round trip me please', 'utf8');
  const expected = crypto.createHash('sha256').update(content).digest('hex');
  const result = await writeLocalFile(`local-file-write-test-${Date.now()}.txt`, content);
  assert.equal(result.bytes, content.length);
  assert.equal(result.sha256, expected);
  const fs = await import('node:fs/promises');
  const onDisk = await fs.readFile(result.path);
  assert.equal(onDisk.toString('utf8'), 'round trip me please');
  await fs.unlink(result.path);
});

test('writeLocalFile rejects a traversal path without touching disk', async () => {
  await assert.rejects(() => writeLocalFile('../nope.txt', Buffer.from('x')), /bad_path/);
});
