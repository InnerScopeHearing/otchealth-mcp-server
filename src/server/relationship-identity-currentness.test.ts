import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createRelationshipIdentityCurrentnessResolver } from './relationship-identity-currentness.js';
import { createIdentityCurrentnessPointer } from './relationship-query/identity-currentness-proof.mjs';

const canonical = (value: any): string => value === null || typeof value !== 'object' ? JSON.stringify(value) :
  Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const authority = { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'synthetic',
    source_system: 'synthetic', scope: 'cfo', version: '1' };
  const endpoint = { display_name: 'Alpha', entity_type: 'organization',
    identifier: { namespace: 'vendor', scope: 'synthetic-ledger', value: '1' } };
  const entityId = 'entity_' + sha(canonical({ entity_type: endpoint.entity_type, namespace: endpoint.identifier.namespace,
    scope: endpoint.identifier.scope, value: endpoint.identifier.value }));
  const binding = { source_document_version: 'synthetic-version', chunk_sha256: sha('Alpha owns Beta.') };
  const request = { evidence: { source_binding: binding }, candidate: { subject: 'Alpha' }, side: 'subject', endpoint, entity_id: entityId };
  const entry = { source_document_version: binding.source_document_version, source_sha256: binding.chunk_sha256,
    mention: 'Alpha', endpoint };
  const unsigned = { registry_id: 'synthetic', source_authority: authority, source_version: 'source-v1',
    entries: [entry], revocations: [] };
  const version = 'sirv_' + sha(canonical(unsigned));
  const publicKeySha256 = sha(keys.publicKey.export({ type: 'spki', format: 'der' }));
  const snapshot = { schema: 'source-identity-registry-v1', registry_id: 'synthetic', version, entries: [entry],
    revocations: [], source_authority: authority, source_version: 'source-v1', public_key_sha256: publicKeySha256 };
  const envelope = { snapshot, signature: sign(null, Buffer.from(canonical(snapshot)), keys.privateKey).toString('base64') };
  const requestSha256 = sha(canonical(request));
  const pointer = createIdentityCurrentnessPointer({ mode: 'snapshot', registry_id: 'synthetic', registry_version: version,
    public_key_sha256: publicKeySha256, snapshot_sha256: sha(canonical(snapshot)), entry_sha256: sha(canonical(entry)) }, requestSha256);
  const proof = { verified: true, request_sha256: requestSha256, verifier_id: 'signed-source-identity-registry',
    verifier_version: '1', basis: 'Structured synthetic authority.', identity_currentness: pointer };
  const caller: any = { caller_agent: 'cfo', caller_hash: sha('cfo'), connector_surface: true,
    raw_token: 'synthetic', m365_static_auth: false };
  return { keys, authority, endpoint, request, entry, snapshot, envelope, proof, caller, version };
}

test('production-native snapshot adapter returns the exact recorded proof only while registry and source remain current', async () => {
  const f = fixture(); let reads = 0, sourceCurrent = true;
  const config: any = { registry_id: 'synthetic', authority: f.authority, binding: {},
    public_key: f.keys.publicKey.export({ type: 'spki', format: 'pem' }),
    source: { page: async () => null, current: async () => sourceCurrent },
    snapshots: { publish: async () => false, read: async () => { reads++; return { status: 'active', envelope: f.envelope }; } } };
  const resolver = createRelationshipIdentityCurrentnessResolver({ resolve: async () => config })!;
  const signal = new AbortController().signal;
  assert.deepEqual(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), f.proof);
  assert.equal(reads, 2);
  sourceCurrent = false;
  assert.equal(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), null);
});

test('revoked, late-revoked, mutated and pointerless identity receipts fail closed', async () => {
  const f = fixture(); let reads = 0, late = false;
  const config: any = { registry_id: 'synthetic', authority: f.authority, binding: {},
    public_key: f.keys.publicKey.export({ type: 'spki', format: 'pem' }), source: { page: async () => null, current: async () => true },
    snapshots: { publish: async () => false, read: async () => (++reads === 2 && late) ? { status: 'revoked' } : { status: 'active', envelope: f.envelope } } };
  const resolver = createRelationshipIdentityCurrentnessResolver({ resolve: async () => config })!;
  const signal = new AbortController().signal;
  assert.equal(await resolver.revalidate(f.request, { ...f.proof, identity_currentness: undefined }, f.caller, { signal }), null);
  assert.equal(await resolver.revalidate({ ...f.request, entity_id: 'entity_' + sha('other') }, f.proof, f.caller, { signal }), null);
  late = true; reads = 0;
  assert.equal(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), null);
  config.snapshots.read = async () => ({ status: 'revoked' });
  assert.equal(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), null);
});

function partitionFixture() {
  const f = fixture(), binding = f.request.evidence.source_binding;
  const publicKeySha256 = sha(f.keys.publicKey.export({ type: 'spki', format: 'der' }));
  const bindingHash = sha(canonical({ source_document_version: binding.source_document_version,
    source_sha256: binding.chunk_sha256 }));
  const setHash = (values: string[]) => sha(canonical([...values].sort()));
  const snapshot = { schema: 'source-identity-registry-v1', registry_id: 'synthetic', version: 'shard-v1',
    source_authority: f.authority, source_version: 'source-v1', public_key_sha256: publicKeySha256,
    partition_binding_hashes: [bindingHash], entries: [f.entry], revocations: [] };
  const shardEnvelope = { snapshot, signature: sign(null, Buffer.from(canonical(snapshot)), f.keys.privateKey).toString('base64') };
  const selectedPrefix = bindingHash[0], shards = '0123456789abcdef'.split('').map(prefix => ({ shard_id: `shard-${prefix}`,
    partition_prefix: prefix, registry_version: prefix === selectedPrefix ? snapshot.version : `empty-${prefix}`,
    snapshot_sha256: prefix === selectedPrefix ? sha(canonical(snapshot)) : sha(`empty-${prefix}`), source_version: 'source-v1',
    binding_count: prefix === selectedPrefix ? 1 : 0, binding_set_sha256: setHash(prefix === selectedPrefix ? [bindingHash] : []) }));
  const coverage = { schema: 'source-identity-catalog-coverage-v1', catalog_version: 'catalog-v1', complete: true,
    coverage_sha256: sha('coverage'), expected_shard_count: 16, source_binding_count: 1,
    source_binding_set_sha256: setHash([bindingHash]) };
  const unsigned = { schema: 'source-identity-registry-partition-manifest-v1', registry_id: 'synthetic',
    source_authority: f.authority, source_generation: 'generation-v1', catalog_coverage: coverage,
    shards, public_key_sha256: publicKeySha256 };
  const manifestVersion = 'sirm_' + sha(canonical(unsigned));
  const manifestSnapshot = { ...unsigned, version: manifestVersion };
  const manifestEnvelope = { snapshot: manifestSnapshot,
    signature: sign(null, Buffer.from(canonical(manifestSnapshot)), f.keys.privateKey).toString('base64') };
  const requestSha256 = sha(canonical(f.request));
  const pointer = createIdentityCurrentnessPointer({ mode: 'partition', registry_id: 'synthetic',
    manifest_version: manifestVersion, manifest_sha256: sha(canonical(manifestSnapshot)), shard_id: `shard-${selectedPrefix}`,
    public_key_sha256: publicKeySha256, snapshot_sha256: sha(canonical(snapshot)), entry_sha256: sha(canonical(f.entry)) }, requestSha256);
  return { ...f, bindingHash, manifestVersion, manifestEnvelope, shardEnvelope,
    proof: { ...f.proof, verifier_id: 'signed-source-identity-registry-partitioned', identity_currentness: pointer } };
}

test('partition adapter rereads signed authority and fails closed on late shard revocation or withdrawn coverage', async () => {
  const f = partitionFixture(); let shardReads = 0, lateRevoke = false, covered = true;
  const partitions: any = { manifest_version: f.manifestVersion,
    publish_manifest: async () => false, publish_shard: async () => false,
    read_manifest: async () => ({ status: 'active', envelope: f.manifestEnvelope }),
    read_shard: async () => (++shardReads === 2 && lateRevoke) ? { status: 'revoked' } : { status: 'active', envelope: f.shardEnvelope },
    manifest_current: async () => true, shard_current: async () => true,
    binding_covered: async ({ source_binding_hash }: any) => covered && source_binding_hash === f.bindingHash,
    coverage_page: async () => null };
  const config: any = { registry_id: 'synthetic', authority: f.authority, binding: {},
    public_key: f.keys.publicKey.export({ type: 'spki', format: 'pem' }), source: { page: async () => null, current: async () => true },
    snapshots: { publish: async () => false, read: async () => ({ status: 'missing' }) }, partitions };
  const resolver = createRelationshipIdentityCurrentnessResolver({ resolve: async () => config })!;
  const signal = new AbortController().signal;
  assert.deepEqual(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), f.proof);
  assert.equal(shardReads, 2);
  lateRevoke = true; shardReads = 0;
  assert.equal(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), null);
  lateRevoke = false; shardReads = 0; covered = false;
  assert.equal(await resolver.revalidate(f.request, f.proof, f.caller, { signal }), null);
});
