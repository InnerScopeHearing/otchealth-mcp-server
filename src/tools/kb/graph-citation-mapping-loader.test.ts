import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clearGraphCitationMappingCacheForTests, loadGraphCitationMappings, type CitationMappingArtifactConfig } from './graph-citation-mapping-loader.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const mapping = {
  canonical_id: 'a'.repeat(64),
  source_version: `sha256:${'b'.repeat(64)}`,
  source_group: 'company_shared',
  source_sha256: 'b'.repeat(64),
  source_locator_sha256: 'c'.repeat(64),
  provenance_receipt_sha256: 'd'.repeat(64),
};
const artifactText = JSON.stringify([mapping]);
const config: CitationMappingArtifactConfig = {
  bucket: 'citation-mappings-test', key: 'approved/v1/mappings.json', versionId: 'version-123', sha256: digest(artifactText),
};
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const signer = (opts: { host: string; path: string; query: string }) => ({ headers: { host: opts.host, 'x-test-signed': `${opts.path}?${opts.query}` } });

function response(text = artifactText, versionId = config.versionId, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'x-amz-version-id': versionId } });
}

test('loads only a pinned, SHA-verified, six-field mapping and caches the verified result', async () => {
  clearGraphCitationMappingCacheForTests();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(); }) as typeof fetch;
  const first = await loadGraphCitationMappings(config, credentials, fetchImpl, signer as any);
  const second = await loadGraphCitationMappings(config, credentials, fetchImpl, signer as any);
  assert.deepEqual(first, [mapping]);
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://citation-mappings-test.s3.us-east-1.amazonaws.com/approved/v1/mappings.json?versionId=version-123');
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.redirect, 'error');
});

test('missing, stale-version, digest-mismatched, oversized, and malformed artifacts fail closed', async () => {
  clearGraphCitationMappingCacheForTests();
  const validFetch = (text: string, version = config.versionId) => (async () => response(text, version)) as typeof fetch;
  assert.deepEqual(await loadGraphCitationMappings(undefined, credentials, validFetch(artifactText), signer as any), []);
  assert.deepEqual(await loadGraphCitationMappings(config, null, validFetch(artifactText), signer as any), []);
  assert.deepEqual(await loadGraphCitationMappings(config, credentials, validFetch(artifactText, 'older-version'), signer as any), []);
  assert.deepEqual(await loadGraphCitationMappings({ ...config, sha256: 'e'.repeat(64) }, credentials, validFetch(artifactText), signer as any), []);
  const malformed = 'not json';
  assert.deepEqual(await loadGraphCitationMappings({ ...config, sha256: digest(malformed) }, credentials, validFetch(malformed), signer as any), []);
  const oversized = ' '.repeat(5 * 1024 * 1024 + 1);
  assert.deepEqual(await loadGraphCitationMappings(config, credentials, validFetch(oversized), signer as any), []);
  const tooMany = JSON.stringify(Array.from({ length: 10_001 }, (_, index) => ({ ...mapping, canonical_id: index.toString(16).padStart(64, '0') })));
  assert.ok(Buffer.byteLength(tooMany) < 5 * 1024 * 1024);
  assert.deepEqual(await loadGraphCitationMappings({ ...config, sha256: digest(tooMany) }, credentials, validFetch(tooMany), signer as any), []);
  const extraField = JSON.stringify([{ ...mapping, source_uri: 's3://must-not-leak' }]);
  assert.deepEqual(await loadGraphCitationMappings({ ...config, sha256: digest(extraField) }, credentials, validFetch(extraField), signer as any), []);
  clearGraphCitationMappingCacheForTests();
});

test('rejects duplicate identities and object versions that are not immutable', async () => {
  clearGraphCitationMappingCacheForTests();
  const duplicates = JSON.stringify([mapping, mapping]);
  const duplicateConfig = { ...config, sha256: digest(duplicates) };
  assert.deepEqual(await loadGraphCitationMappings(duplicateConfig, credentials, (async () => response(duplicates)) as typeof fetch, signer as any), []);
  assert.deepEqual(await loadGraphCitationMappings({ ...config, versionId: 'null' }, credentials, (async () => response()) as typeof fetch, signer as any), []);
  clearGraphCitationMappingCacheForTests();
});
