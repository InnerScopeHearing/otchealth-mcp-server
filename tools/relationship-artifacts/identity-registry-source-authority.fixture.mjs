import { createHash, generateKeyPairSync, sign } from 'node:crypto';

export const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonicalJson).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
const sha256 = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value), 'utf8')).digest('hex');

/** Synthetic source-owner export for tests. Every identifier is supplied by the source record. */
export function createIdentityRegistrySourceAuthorityFixture() {
  const keys = generateKeyPairSync('ed25519');
  const authority = { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'synthetic-source-owner', source_system: 'synthetic-ledger', scope: 'cfo', version: 'source-v1' };
  const runContent = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'graph', scope: 'finance', run_version: 'fixture-v1', manifest_sha256: 'a'.repeat(64) };
  const run = { ...runContent, run_id: 'run_' + sha256(runContent) };
  const catalog = { catalog_version: 'synthetic-catalog-v1', catalog_sha256: 'b'.repeat(64) };
  const partitionManifestVersion = 'sirm_' + 'c'.repeat(64);
  const prefix = 'graph-trial/source-authority/synthetic-cfo-registry';
  const pageKey = `${prefix}/pages/page-0.json`, coverageKey = `${prefix}/coverage/page-0.json`;
  const manifestKey = `${prefix}/exports/manifest.json`, pointerKey = `${prefix}/exports/current.json`;
  const record = { source_record_id: 'synthetic-source-record-1', source_document_version: 'synthetic-document-v1', source_sha256: 'e'.repeat(64), mention: 'SyntheticEntity', disposition: 'resolved', endpoint: { display_name: 'SyntheticEntity', entity_type: 'organization', identifier: { namespace: 'synthetic', scope: 'finance', value: 'entity-1' } } };
  const pageValue = { schema: 'structured-identity-source-page-v1', authority, current: true, source_version: 'source-v1', records: [record], next_cursor: null };
  const coverageValue = { schema: 'source-identity-catalog-coverage-page-v1', source_generation: 'generation-1', catalog_version: catalog.catalog_version, coverage_sha256: catalog.catalog_sha256, binding_hashes: ['d'.repeat(64)], next_cursor: null };
  const page = { cursor: null, key: pageKey, version_id: 'source-page-v1', sha256: sha256(pageValue), source_version: 'source-v1' };
  const coverage = { cursor: null, key: coverageKey, version_id: 'coverage-page-v1', sha256: sha256(coverageValue), source_version: 'source-v1' };
  const shardKey = `${prefix}/shards/shard-0.json`;
  const shardValue = { schema: 'source-identity-registry-explicit-export-shard-current-v1', registry_id: 'synthetic-cfo-registry', partition_manifest_version: partitionManifestVersion, shard_id: 'synthetic-shard-0', registry_version: 'synthetic-registry-v1', source_version: 'source-v1', source_generation: 'generation-1', current: true };
  const shard = { shard_id: 'synthetic-shard-0', key: shardKey, version_id: 'source-shard-v1', sha256: sha256(shardValue), registry_version: 'synthetic-registry-v1', source_version: 'source-v1' };
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const unsigned = { registry_id: 'synthetic-cfo-registry', source_authority: authority, run, catalog, partition_manifest_version: partitionManifestVersion, source_generation: 'generation-1', pages: [page], coverage_pages: [coverage], shards: [shard], coverage_binding_count: 1, coverage_binding_sha256: sha256(['d'.repeat(64)]), public_key_sha256: sha256(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const signed = snapshot => ({ snapshot, signature: sign(null, Buffer.from(canonicalJson(snapshot), 'utf8'), keys.privateKey).toString('base64') });
  const manifest = signed({ schema: 'source-identity-registry-explicit-export-manifest-v1', ...unsigned, version: 'siex_' + sha256(unsigned) });
  let pointer = signed({ schema: 'source-identity-registry-explicit-export-current-v1', registry_id: unsigned.registry_id, manifest_version: manifest.snapshot.version, source_generation: unsigned.source_generation, expires_at: '2030-01-01T00:00:00.000Z', revoked: false });
  const object = (value, version_id) => ({ value, version_id, body: Buffer.from(canonicalJson(value), 'utf8'), sha256: sha256(value) });
  const objects = new Map([
    [manifestKey, object(manifest, 'source-manifest-v1')],
    [pageKey, object(pageValue, page.version_id)],
    [coverageKey, object(coverageValue, coverage.version_id)],
    [shardKey, object(shardValue, shard.version_id)],
    [pointerKey, object(pointer, 'source-pointer-v1')],
  ]);
  const setPointer = value => { pointer = value; objects.set(pointerKey, object(pointer, 'source-pointer-v1')); };
  const config = { registryId: unsigned.registry_id, authority, run, catalog, partitionManifestVersion, publicKey, manifest: { key: manifestKey, version_id: 'source-manifest-v1', sha256: sha256(manifest) }, pointer: { key: pointerKey }, readJson: async (request, _options) => { const object = objects.get(request.key); if (!object || (request.version_id !== undefined && request.version_id !== object.version_id) || (request.sha256 !== undefined && request.sha256 !== object.sha256)) throw new Error('synthetic-source-missing'); return { value: object.value, version_id: object.version_id }; }, now: () => Date.parse('2026-09-09T00:00:00.000Z') };
  return { config, objects, wireObjects: objects, get pointer() { return pointer; }, setPointer, sign: signed, manifest, shard, shardValue, page: pageValue, coverage: coverageValue, record, catalog, partitionManifestVersion };
}
