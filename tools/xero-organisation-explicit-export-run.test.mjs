import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runXeroOrganisationExplicitExport } from './xero-organisation-explicit-export-run.mjs';
const { canonicalXeroOrganisationProjection, projectXeroOrganisation, bindImmutableXeroOrganisationProjection } = await import('../src/server/xero-organisation-source-adapter.ts');

const sourcePrefix = 'graph-trial/20260912/identity-registry/cfo-pilot/source';
const targetPrefix = 'graph-trial/20260912/identity-registry/cfo-pilot/snapshots';
const policy = 'a'.repeat(64), scope = prefix => createHash('sha256').update(JSON.stringify({ bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix, policy_sha256: policy })).digest('hex');
const storage = prefix => ({ bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix, region: 'us-east-1', approved_policy_canonical_sha256: policy, approved_storage_scope_sha256: scope(prefix), sse: { algorithm: 'AES256' } });
const projection = projectXeroOrganisation({ tenantId: 'tenant-synthetic', response: { Organisations: [{ OrganisationID: 'org-synthetic', LegalName: 'Synthetic Corporate Master', OrganisationEntityType: 'COMPANY', OrganisationStatus: 'ACTIVE' }] } });
const pinned = canonicalXeroOrganisationProjection(projection);
const handoff = () => ({ schema: 'cfo-xero-organisation-explicit-export-handoff-v1', source: { storage: storage(sourcePrefix), key: `${sourcePrefix}/identity-registries/xero-organisation/${pinned.sha256}.json`, version_id: 'source-version-1', sha256: pinned.sha256 }, export_input: {
  registry_id: 'cfo-registry', authority: { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'cfo-source-owner', source_system: 'xero', scope: 'cfo', version: 'v1' },
  run: { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'identity', scope: 'finance', run_version: 'v1', manifest_sha256: 'b'.repeat(64), run_id: '' },
  catalog: { catalog_version: 'catalog-v1', catalog_sha256: 'c'.repeat(64) }, partition_manifest_version: 'sirm_' + 'd'.repeat(64), source_generation: 'generation-1', source_version: 'source-v1', prefix: targetPrefix, expires_at: '2030-01-01T00:00:00.000Z', shards: [{ shard_id: 'shard-0', registry_version: 'registry-v1' }],
} });
function configured(value = handoff()) { const run = value.export_input.run; run.run_id = 'run_' + createHash('sha256').update(JSON.stringify({ ref_version: run.ref_version, purpose: run.purpose, scope: run.scope, run_version: run.run_version, manifest_sha256: run.manifest_sha256 })).digest('hex'); return value; }
const ports = { schema: 'cfo-identity-registry-explicit-export-ports-v1', kms: { region: 'us-east-1', key_id: 'arn:aws:kms:us-east-1:900915535335:key/00000000-0000-0000-0000-000000000000' }, source_storage: storage(targetPrefix) };
function runtime({ version = 'source-version-1', body = Buffer.from(pinned.payload) } = {}) { return { preflight: async () => ({ ok: true }), request: async request => { assert.equal(request.method, 'GET'); assert.equal(request.versionId, 'source-version-1'); return { status: 200, headers: new Headers({ 'x-amz-version-id': version, 'x-amz-server-side-encryption': 'AES256' }), body }; } }; }
function options(overrides = {}) { let output; let signerCalls = 0, publishCalls = 0; return { value: { argv: ['--handoff', 'C:\\handoff.json', '--ports', 'C:\\ports.json', '--output', 'C:\\result.json'], read: async path => path.endsWith('handoff.json') ? JSON.stringify(configured()) : JSON.stringify(ports), runtimeFactory: () => overrides.runtime ?? runtime(), bind: bindImmutableXeroOrganisationProjection, signerFactory: async () => { signerCalls++; return { publicKey: 'synthetic', maxMessageBytes: 4096, sign: async () => Buffer.alloc(64) }; }, storeFactory: () => ({ maxVersionIdBytes: 128, putImmutable: async () => ({ version_id: 'unused' }) }), publish: async ({ input, signer, store }) => { publishCalls++; assert.equal(input.records.length, 1); assert.equal(input.bindings.length, 1); assert.equal(input.records[0].source_record_id, 'org-synthetic'); assert.equal(input.records[0].source_document_version, 'source-version-1'); assert.equal(input.records[0].source_sha256, pinned.sha256); assert.equal(signer.maxMessageBytes, 4096); assert.equal(store.maxVersionIdBytes, 128); return { public_config: {}, receipt: {} }; }, write: async (_path, value, writeOptions) => { output = { value, writeOptions }; }, get output() { return output; }, get signerCalls() { return signerCalls; }, get publishCalls() { return publishCalls; } } }; }

test('accepts the exact pinned projection and invokes the real binder and exporter ports', async () => {
  const f = options(); assert.deepEqual(await runXeroOrganisationExplicitExport(f.value), { output_written: true });
  assert.equal(f.value.signerCalls, 1); assert.equal(f.value.publishCalls, 1); assert.equal(f.value.output.writeOptions.flag, 'wx'); assert.equal(f.value.output.writeOptions.mode, 0o600);
});
test('refuses wrong version, hash and truncated source before signer or exporter invocation', async () => {
  for (const candidate of [runtime({ version: 'wrong-version' }), runtime({ body: Buffer.from('{"forged":true}') }), runtime({ body: Buffer.from(pinned.payload.slice(0, -1)) })]) {
    const f = options({ runtime: candidate }); await assert.rejects(runXeroOrganisationExplicitExport(f.value), { code: 'xero_export_source_pin_invalid' }); assert.equal(f.value.signerCalls, 0); assert.equal(f.value.publishCalls, 0);
  }
});
test('preserves create-only output behavior on replay', async () => {
  const f = options(); const original = f.value.write; let calls = 0; f.value.write = async (...args) => { if (++calls > 1) { const error = Object.assign(new Error('exists'), { code: 'EEXIST' }); throw error; } return original(...args); };
  await runXeroOrganisationExplicitExport(f.value); await assert.rejects(runXeroOrganisationExplicitExport(f.value), { code: 'EEXIST' });
});
