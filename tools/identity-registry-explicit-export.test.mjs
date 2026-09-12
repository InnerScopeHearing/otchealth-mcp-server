import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, publishExplicitIdentityRegistryExport } from './identity-registry-explicit-export.mjs';
const { createIdentityRegistrySourceAuthority } = await import('../dist/server/identity-registry-source-authority.js');

const sha = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const runBase = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'pilot', scope: 'finance', run_version: 'pilot-v1', manifest_sha256: 'a'.repeat(64) };
  const binding = { source_document_version: 'docv_' + 'b'.repeat(64), chunk_sha256: 'c'.repeat(64) };
  const input = { registry_id: 'cfo-pilot', authority: { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'cfo-source-owner', source_system: 'cfo-ledger', scope: 'cfo', version: 'v1' }, run: { ...runBase, run_id: 'run_' + sha(runBase) }, catalog: { catalog_version: 'catalog-v1', catalog_sha256: 'd'.repeat(64) }, partition_manifest_version: 'sirm_' + 'e'.repeat(64), source_generation: 'generation-1', source_version: 'source-v1', prefix: 'graph-trial/cfo-identity-pilot', expires_at: '2030-01-01T00:00:00.000Z', bindings: [binding], shards: [{ shard_id: 'shard-0', registry_version: 'registry-v1' }], records: [{ source_record_id: 'cfo-native-record-1', source_document_version: binding.source_document_version, source_sha256: binding.chunk_sha256, mention: 'Synthetic Supplier Inc', disposition: 'resolved', endpoint: { display_name: 'Synthetic Supplier Inc', entity_type: 'organization', identifier: { namespace: 'cfo-system', scope: 'supplier', value: 'synthetic-1' } } }] };
  const objects = new Map(); let sequence = 0;
  const store = { putImmutable: async ({ key, body }) => { const found = objects.get(key); if (found) { assert.deepEqual(found.body, body, 'a retry may only reuse byte-identical immutable content'); return { version_id: found.version_id }; } const version_id = `v-${++sequence}`; objects.set(key, { body, version_id }); return { version_id }; } };
  const signer = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), sign: async bytes => sign(null, bytes, keys.privateKey) };
  return { input, objects, signer, store };
}

test('publishes a signed explicit-ID manifest, pages, coverage, shard currentness and pointer through an immutable port', async () => {
  const f = fixture();
  const published = await publishExplicitIdentityRegistryExport({ input: f.input, signer: f.signer, store: { putImmutable: async item => f.store?.putImmutable(item) } });
  assert.equal(published.receipt.page_count, 1);
  assert.equal(published.receipt.coverage_binding_count, 1);
  assert.equal(published.public_config.public_key.includes('PRIVATE'), false);
  assert.equal(f.objects.size, 5);
  assert.match(published.public_config.public_key, /^-----BEGIN PUBLIC KEY-----/);
  for (const key of ['graph-trial/cfo-identity-pilot/exports/manifest.json', 'graph-trial/cfo-identity-pilot/exports/current.json']) {
    const envelope = JSON.parse(f.objects.get(key).body.toString('utf8'));
    assert.equal(verify(null, Buffer.from(canonicalJson(envelope.snapshot)), published.public_config.public_key, Buffer.from(envelope.signature, 'base64')), true,
      `${key} verifies against the emitted public key`);
  }
  const source = createIdentityRegistrySourceAuthority({
    registryId: published.public_config.registry_id, authority: published.public_config.authority,
    run: published.public_config.binding.run, catalog: published.public_config.source.catalog,
    publicKey: published.public_config.public_key, partitionManifestVersion: published.public_config.partition_manifest_version,
    manifest: published.public_config.source.manifest, pointer: published.public_config.source.pointer,
    readJson: async ({ key, version_id, sha256 }) => {
      const object = f.objects.get(key);
      assert.ok(object);
      if (version_id !== undefined) assert.equal(object.version_id, version_id);
      if (sha256 !== undefined) assert.equal(sha(Buffer.from(object.body)), sha256);
      return { value: JSON.parse(Buffer.from(object.body).toString('utf8')), version_id: object.version_id };
    }, now: () => Date.parse('2026-09-11T00:00:00.000Z'),
  });
  const page = await source.source.page({ cursor: null, source_version: null, page_size: 1 });
  assert.equal(page.records[0].mention, 'Synthetic Supplier Inc');
  assert.equal(page.records[0].endpoint.identifier.value, 'synthetic-1');
  const binding = sha({ source_document_version: f.input.bindings[0].source_document_version, source_sha256: f.input.bindings[0].chunk_sha256 });
  assert.equal(await source.partitions.binding_covered({ registry_id: f.input.registry_id, manifest_version: f.input.partition_manifest_version, source_generation: f.input.source_generation, catalog_version: f.input.catalog.catalog_version, coverage_sha256: f.input.catalog.catalog_sha256, source_binding_hash: binding }), true);
});

test('is deterministically retryable through an immutable compare-on-conflict store', async () => {
  const f = fixture();
  const first = await publishExplicitIdentityRegistryExport({ input: f.input, signer: f.signer, store: f.store });
  const second = await publishExplicitIdentityRegistryExport({ input: f.input, signer: f.signer, store: f.store });
  assert.deepEqual(second, first);
  assert.equal(f.objects.size, 5);
});

test('refuses invalid records, keys, duplicate IDs, private keys and forged signatures before any immutable write', async () => {
  const f = fixture();
  const nameOnly = structuredClone(f.input); delete nameOnly.records[0].endpoint;
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: nameOnly, signer: f.signer, store: f.store }), { code: 'identity_export_record_not_explicit' });
  const duplicateRecord = structuredClone(f.input); duplicateRecord.records.push(structuredClone(duplicateRecord.records[0]));
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: duplicateRecord, signer: f.signer, store: f.store }), { code: 'identity_export_record_duplicate' });
  const duplicateShard = structuredClone(f.input); duplicateShard.shards.push(structuredClone(duplicateShard.shards[0]));
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: duplicateShard, signer: f.signer, store: f.store }), { code: 'identity_export_shard_invalid' });
  const unsafeShard = structuredClone(f.input); unsafeShard.shards[0].shard_id = '../escape';
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: unsafeShard, signer: f.signer, store: f.store }), { code: 'identity_export_shard_invalid' });
  const privateKeySigner = { ...f.signer, publicKey: f.signer.privateKey ?? generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: f.input, signer: privateKeySigner, store: f.store }), { code: 'identity_export_signer_invalid' });
  const forgedSigner = { ...f.signer, sign: async () => Buffer.alloc(64) };
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: f.input, signer: forgedSigner, store: f.store }), { code: 'identity_export_signature_invalid' });
  assert.equal(f.objects.size, 0);
});
