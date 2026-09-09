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
