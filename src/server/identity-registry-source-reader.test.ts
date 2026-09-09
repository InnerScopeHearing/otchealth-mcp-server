import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createIdentityRegistrySourceReader } from './identity-registry-source-reader.js';

const prefix = 'graph-trial/source-authority';
const body = JSON.stringify({ synthetic_only: true });
const sha256 = createHash('sha256').update(body).digest('hex');
const pin = { key: prefix + '/manifest.json', version_id: 'synthetic-version-1', sha256 };
const options = () => ({ signal: new AbortController().signal });
const response = (headers: Record<string, string> = {}) => new Response(body, { headers: {
  'x-amz-version-id': pin.version_id, 'x-amz-server-side-encryption': 'AES256', ...headers,
} });
test('source reader signs only fixed finance-ring GET with exact version and verifies bytes', async () => {
  let calls = 0;
  const read = createIdentityRegistrySourceReader({ prefix }, {
    sign: async request => {
      assert.equal(request.method, 'GET');
      assert.equal(request.host, 'otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com');
      assert.equal(request.query, 'versionId=synthetic-version-1');
      return { headers: { 'x-synthetic-signature': 'synthetic-only' } };
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).searchParams.get('versionId'), pin.version_id);
      assert.equal(init?.redirect, 'error');
      return response({ 'content-length': String(Buffer.byteLength(body)) });
    },
  });
  assert.deepEqual(await read(pin, options()), { value: { synthetic_only: true }, version_id: pin.version_id });
  assert.equal(calls, 1);
  for (const invalid of [
    { ...pin, key: 'graph-trial/other/manifest.json' },
    { ...pin, key: prefix + '/../outside.json' },
    { ...pin, key: prefix + '/%2e%2e/outside.json' },
    { ...pin, version_id: 'null' },
    { key: pin.key, version_id: pin.version_id },
  ]) await assert.rejects(read(invalid, options()), /identity_source_unavailable/);
  assert.equal(calls, 1);
});
test('source reader rejects changed version, hashes, unencrypted objects and malformed lengths', async () => {
  for (const headers of [
    { 'x-amz-version-id': 'changed' }, { 'x-amz-version-id': 'null' },
    { 'x-amz-server-side-encryption': '' }, { 'content-length': 'invalid' },
    { 'content-length': '-1' }, { 'content-length': '999999' }, { 'content-length': '1' },
  ]) {
    const read = createIdentityRegistrySourceReader({ prefix }, { sign: async () => ({ headers: {} }), fetch: async () => response(headers) });
    await assert.rejects(read(pin, options()), /identity_source_unavailable/);
  }
  const read = createIdentityRegistrySourceReader({ prefix }, { sign: async () => ({ headers: {} }), fetch: async () => response() });
  await assert.rejects(read({ ...pin, sha256: '0'.repeat(64) }, options()), /identity_source_unavailable/);
});
test('source reader bounds ignored cancellation in signing, fetch and response stream', async () => {
  const never = () => new Promise<never>(() => undefined);
  for (const injected of [
    { sign: never, fetch: async () => response() },
    { sign: async () => ({ headers: {} }), fetch: never },
    { sign: async () => ({ headers: {} }), fetch: async () => new Response(new ReadableStream({ pull: never }), {
      headers: { 'x-amz-version-id': pin.version_id, 'x-amz-server-side-encryption': 'AES256' },
    }) },
  ]) {
    const read = createIdentityRegistrySourceReader({ prefix, timeoutMs: 20 }, injected);
    await assert.rejects(read(pin, options()), /identity_source_unavailable/);
  }
  let called = false;
  const read = createIdentityRegistrySourceReader({ prefix }, { sign: async () => { called = true; return { headers: {} }; } });
  await assert.rejects(read(pin, { signal: AbortSignal.abort() }), /identity_source_unavailable/);
  assert.equal(called, false);
});
