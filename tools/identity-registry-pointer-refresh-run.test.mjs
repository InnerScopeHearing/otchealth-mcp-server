import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { CONFIG, runPointerRefresh } from './identity-registry-pointer-refresh-run.mjs';

const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const prefix = 'graph-trial/20260912/identity-registry/cfo-pilot/snapshots';
const now = () => Date.parse('2026-09-12T23:00:00.000Z');
function fixture({ current = true } = {}) {
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), source_sha256 = 'a'.repeat(64);
  const manifest = { schema: 'source-identity-registry-explicit-export-manifest-v1', registry_id: 'cfo-identity-registry-pilot', source_authority: {}, run: {}, catalog: { catalog_sha256: source_sha256 }, partition_manifest_version: 'sirm_' + 'b'.repeat(64), source_generation: `xero-organisation-${source_sha256.slice(0,16)}`, pages: [], coverage_pages: [], shards: [], coverage_binding_count: 1, coverage_binding_sha256: 'c'.repeat(64), public_key_sha256: sha(keys.publicKey.export({ type: 'spki', format: 'der' })), version: 'siex_' + 'd'.repeat(64) };
  const signed = snapshot => ({ snapshot, signature: sign(null, Buffer.from(canonical(snapshot)), keys.privateKey).toString('base64') });
  const pointer = { schema: 'source-identity-registry-explicit-export-current-v1', registry_id: manifest.registry_id, manifest_version: manifest.version, source_generation: manifest.source_generation, expires_at: '2026-09-12T22:00:00.000Z', revoked: false };
  const bodies = new Map([[`${prefix}/exports/manifest.json`, Buffer.from(canonical(signed(manifest)))], [`${prefix}/exports/current.json`, Buffer.from(canonical(signed(pointer)))] ]);
  const versions = new Map([[`${prefix}/exports/manifest.json`, 'manifest-v1'], [`${prefix}/exports/current.json`, 'pointer-v1']]);
  const pin = key => ({ key, version_id: versions.get(key), sha256: sha(bodies.get(key)) });
  const storage = { bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix, region: 'us-east-1', approvedPolicyCanonicalSha256: 'e'.repeat(64), approvedStorageScopeSha256: sha(canonical({ bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix, policy_sha256: 'e'.repeat(64) })), sse: { algorithm: 'AES256' } };
  let writes = 0, sourceChecks = 0, output;
  const runtime = { preflight: async () => undefined, request: async ({ key, versionId }) => { const body = bodies.get(key); return body ? { status: 200, headers: new Headers({ 'x-amz-version-id': versions.get(key), 'x-amz-server-side-encryption': 'AES256' }), body } : { status: 404, headers: new Headers(), body: Buffer.alloc(0) }; } };
  const signer = { publicKey, maxMessageBytes: 4096, sign: async bytes => sign(null, bytes, keys.privateKey) };
  const args = ['--refresh', '/tmp/refresh.json', '--ports', '/tmp/ports.json', '--output', '/tmp/result.json'];
  return { args, read: async path => path.endsWith('refresh.json') ? JSON.stringify({ schema: CONFIG.schema, manifest: pin(`${prefix}/exports/manifest.json`), prior_pointer: pin(`${prefix}/exports/current.json`), expires_at: '2026-09-13T00:00:00.000Z' }) : JSON.stringify({ schema: 'cfo-identity-registry-explicit-export-ports-v1', kms: { region: 'us-east-1', key_id: 'arn:aws:kms:us-east-1:900915535335:key/00000000-0000-0000-0000-000000000000' }, source_storage: { bucket: storage.bucket, prefix: storage.prefix, region: storage.region, approved_policy_canonical_sha256: storage.approvedPolicyCanonicalSha256, approved_storage_scope_sha256: storage.approvedStorageScopeSha256, sse: storage.sse } }), write: async (_path, value) => { output = value; }, runtimeFactory: () => runtime, signerFactory: async () => signer, currentSource: async () => { sourceChecks++; return { source_sha256: current ? source_sha256 : 'f'.repeat(64), source_generation: `xero-organisation-${(current ? source_sha256 : 'f'.repeat(64)).slice(0,16)}` }; }, storeFactory: () => ({ putImmutable: async ({ key, body }) => { writes++; const prior = bodies.get(key); if (prior) assert.deepEqual(prior, body); else { bodies.set(key, body); versions.set(key, `refresh-v${writes}`); } return { version_id: versions.get(key) }; } }), stats: () => ({ writes, sourceChecks, output, bodies }) };
}

test('refreshes an expired pointer without republishing the immutable manifest', async () => {
  const f = fixture(); const result = await runPointerRefresh({ argv: f.args, read: f.read, write: f.write, now, runtimeFactory: f.runtimeFactory, signerFactory: f.signerFactory, currentSource: f.currentSource, storeFactory: f.storeFactory });
  assert.equal(result.status, 'refreshed'); assert.equal(result.source_current, true); assert.equal(result.writes_performed, true); assert.match(result.pointer.key, new RegExp(`^${prefix}/exports/pointers/[a-f0-9]{64}\\.json$`));
  assert.equal(f.stats().writes, 1); assert.equal(f.stats().sourceChecks, 2); assert.equal(f.stats().bodies.has(`${prefix}/exports/manifest.json`), true); assert.equal(JSON.parse(f.stats().output).pointer.key, result.pointer.key);
});

test('fails before signing or writing when current source digest changed', async () => {
  const f = fixture({ current: false }); await assert.rejects(() => runPointerRefresh({ argv: f.args, read: f.read, write: f.write, now, runtimeFactory: f.runtimeFactory, signerFactory: f.signerFactory, currentSource: f.currentSource, storeFactory: f.storeFactory }), { code: 'identity_pointer_refresh_source_not_current' });
  assert.equal(f.stats().writes, 0); assert.equal(f.stats().sourceChecks, 1);
});