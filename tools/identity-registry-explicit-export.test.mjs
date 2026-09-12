import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, publishExplicitIdentityRegistryExport } from './identity-registry-explicit-export.mjs';
const { createIdentityRegistrySourceAuthority } = await import('../dist/server/identity-registry-source-authority.js');

const sha = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const runBase = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'pilot', scope: 'finance', run_version: 'pilot-v1', manifest_sha256: 'a'.repeat(64) };
  const binding = { source_document_version: 'docv_' + 'b'.repeat(64), chunk_sha256: 'c'.repeat(64) };
  const input = { registry_id: 'cfo-pilot', authority: { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'cfo-source-owner', source_system: 'cfo-ledger', scope: 'cfo', version: 'v1' }, run: { ...runBase, run_id: 'run_' + sha(runBase) }, catalog: { catalog_version: 'catalog-v1', catalog_sha256: 'd'.repeat(64) }, partition_manifest_version: 'sirm_' + 'e'.repeat(64), source_generation: 'generation-1', source_version: 'source-v1', prefix: 'graph-trial/cfo-identity-pilot', expires_at: '2030-01-01T00:00:00.000Z', bindings: [binding], shards: [{ shard_id: 'shard-0', registry_version: 'registry-v1' }], records: [{ source_record_id: 'cfo-native-record-1', source_document_version: binding.source_document_version, source_sha256: binding.chunk_sha256, mention: 'SyntheticSupplier', disposition: 'resolved', endpoint: { display_name: 'SyntheticSupplier', entity_type: 'organization', identifier: { namespace: 'cfo-system', scope: 'supplier', value: 'synthetic-1' } } }] };
  const objects = new Map(); let sequence = 0;
  const store = { putImmutable: async ({ key, body }) => { assert.equal(objects.has(key), false); const version_id = `v-${++sequence}`; objects.set(key, { body, version_id }); return { version_id }; } };
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
  assert.equal(page.records[0].endpoint.identifier.value, 'synthetic-1');
  const binding = sha({ source_document_version: f.input.bindings[0].source_document_version, source_sha256: f.input.bindings[0].chunk_sha256 });
  assert.equal(await source.partitions.binding_covered({ registry_id: f.input.registry_id, manifest_version: f.input.partition_manifest_version, source_generation: f.input.source_generation, catalog_version: f.input.catalog.catalog_version, coverage_sha256: f.input.catalog.catalog_sha256, source_binding_hash: binding }), true);
});

test('refuses name-only and unbound records before any immutable write', async () => {
  const f = fixture();
  const nameOnly = structuredClone(f.input); delete nameOnly.records[0].endpoint;
  await assert.rejects(() => publishExplicitIdentityRegistryExport({ input: nameOnly, signer: f.signer, store: { putImmutable: async item => f.store?.putImmutable(item) } }), { code: 'identity_export_record_not_explicit' });
  assert.equal(f.objects.size, 0);
});
