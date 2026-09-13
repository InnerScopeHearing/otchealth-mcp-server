import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { publishExplicitIdentityRegistryExport } from './identity-registry-explicit-export.mjs';
import { buildExportInput } from './xero-organisation-source-handoff-run.mjs';
import { parseCli, prepareHistoricalXeroOrganisationReconciliation, reconcileHistoricalXeroOrganisationHandoff } from './xero-organisation-explicit-export-reconcile.mjs';
import { createIdentityRegistrySourceAuthority } from '../src/server/identity-registry-source-authority.ts';

const source = { key: 'graph-trial/20260912/identity-registry/cfo-pilot/source/identity-registries/xero-organisation/source.json', version_id: 'V3/AbC+opaque~version', sha256: 'a'.repeat(64), storage: { bucket: 'test', prefix: 'test', region: 'test', sse: { algorithm: 'AES256' } } };
const record = { source_document_version: source.version_id, source_sha256: source.sha256 };
const legacy = Object.freeze({ schema: 'cfo-xero-organisation-explicit-export-handoff-v1', source, export_input: buildExportInput(record, { expiresAt: '2030-01-01T00:00:00.000Z', runVersion: source.version_id }) });

test('reconciles only the historical source-version run label and produces a gateway-constructible successor export', async () => {
  const reconciled = reconcileHistoricalXeroOrganisationHandoff(legacy, { expiresAt: '2030-01-02T00:00:00.000Z' });
  assert.deepEqual(reconciled.private_handoff.source, source);
  assert.equal(reconciled.private_handoff.export_input.catalog.catalog_version, source.version_id);
  assert.notEqual(reconciled.private_handoff.export_input.run.run_version, source.version_id);
  assert.equal(reconciled.receipt.source_pin_preserved, true);
  assert.match(reconciled.receipt.required_successor_storage_prefix, /\/reconciled\/[a-f0-9]{64}$/);
  const keys = generateKeyPairSync('ed25519'), objects = new Map(), input = { ...reconciled.private_handoff.export_input,
    records: [{ source_record_id: 'record-1', source_document_version: record.source_document_version, source_sha256: record.source_sha256, mention: 'Synthetic Organisation', disposition: 'resolved', endpoint: { display_name: 'Synthetic Organisation', entity_type: 'organisation', identifier: { namespace: 'synthetic', scope: 'test', value: 'organisation-1' } } }],
    bindings: [{ source_document_version: record.source_document_version, chunk_sha256: record.source_sha256 }] };
  const result = await publishExplicitIdentityRegistryExport({ input, signer: { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), maxMessageBytes: 64 * 1024, sign: async bytes => sign(null, bytes, keys.privateKey) }, store: { maxVersionIdBytes: 32, putImmutable: async ({ key, body }) => { assert.equal(objects.has(key), false); objects.set(key, body); return { version_id: `version-${objects.size}` }; } } });
  const authority = createIdentityRegistrySourceAuthority({ registryId: result.public_config.registry_id, authority: result.public_config.authority,
    run: result.public_config.binding.run, catalog: result.public_config.source.catalog, partitionManifestVersion: result.public_config.partition_manifest_version,
    publicKey: result.public_config.public_key, manifest: result.public_config.source.manifest, pointer: result.public_config.source.pointer,
    readJson: async () => { throw new Error('not_called'); } });
  assert.equal(typeof authority.source.current, 'function');
});

test('refuses to reinterpret a handoff that is not the exact historical source-generated form', () => {
  assert.throws(() => reconcileHistoricalXeroOrganisationHandoff({ ...legacy, export_input: { ...legacy.export_input, catalog: { ...legacy.export_input.catalog, catalog_version: 'other' } } }, { expiresAt: '2030-01-02T00:00:00.000Z' }), { code: 'identity_registry_legacy_handoff_not_recognized' });
});

test('writes a private successor handoff and reports only the required storage prefix', async () => {
  let written;
  const receipt = await prepareHistoricalXeroOrganisationReconciliation({ argv: ['--handoff', 'C:\\legacy.json', '--expires-at', '2030-01-02T00:00:00.000Z', '--output', 'C:\\reconciled.json'], read: async () => JSON.stringify(legacy), write: async (_path, body, options) => { written = { body, options }; } });
  assert.equal(parseCli(['--handoff', 'legacy.json', '--expires-at', '2030-01-02T00:00:00.000Z', '--output', 'C:\\reconciled.json']), null);
  assert.equal(receipt.writes_performed, false);
  assert.equal(receipt.source_pin_preserved, true);
  assert.equal(written.options.mode, 0o600);
  const handoff = JSON.parse(written.body);
  assert.equal(handoff.schema, legacy.schema);
  assert.equal(handoff.export_input.run.run_version, 'cfo-identity-registry-pilot-v2');
  assert.equal(handoff.export_input.prefix, receipt.required_successor_storage_prefix);
});
