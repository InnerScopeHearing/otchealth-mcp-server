import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExportInput } from './xero-organisation-source-handoff-run.mjs';
import { prepareSuccessorTask, run } from './identity-registry-successor-export-task.mjs';

const source = { key: 'graph-trial/20260912/identity-registry/cfo-pilot/source/identity-registries/xero-organisation/source.json', version_id: 'opaque/V3+source', sha256: 'a'.repeat(64), storage: { bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix: 'graph-trial/20260912/identity-registry/cfo-pilot/source', region: 'us-east-1', sse: { algorithm: 'AES256' }, approved_policy_canonical_sha256: 'b'.repeat(64), approved_storage_scope_sha256: 'c'.repeat(64) } };
const record = { source_document_version: source.version_id, source_sha256: source.sha256 };
const legacy = { schema: 'cfo-xero-organisation-explicit-export-handoff-v1', source, export_input: buildExportInput(record, { expiresAt: '2030-01-01T00:00:00.000Z', runVersion: source.version_id }) };
const ports = { schema: 'cfo-identity-registry-explicit-export-ports-v1', kms: { key_id: 'arn:aws:kms:us-east-1:900915535335:key/11111111-2222-3333-4444-555555555555', region: 'us-east-1' }, source_storage: { bucket: source.storage.bucket, prefix: 'graph-trial/20260912/identity-registry/cfo-pilot/snapshots', region: 'us-east-1', sse: { algorithm: 'AES256' }, approved_policy_canonical_sha256: 'd'.repeat(64), approved_storage_scope_sha256: 'e'.repeat(64) } };
const now = () => Date.parse('2026-09-13T00:00:00.000Z');

test('derives one source-SHA-bound successor attestation while preserving the approved storage authority', () => {
  const prepared = prepareSuccessorTask({ legacyHandoffJson: JSON.stringify(legacy), rootPortsJson: JSON.stringify(ports), expiresAt: '2026-09-13T01:00:00.000Z', now });
  assert.equal(prepared.handoff.source.sha256, source.sha256);
  assert.equal(prepared.handoff.export_input.prefix, `graph-trial/20260912/identity-registry/cfo-pilot/snapshots/reconciled/${source.sha256}`);
  assert.equal(prepared.ports.source_storage.bucket, ports.source_storage.bucket);
  assert.equal(prepared.ports.source_storage.approved_policy_canonical_sha256, ports.source_storage.approved_policy_canonical_sha256);
  assert.notEqual(prepared.ports.source_storage.approved_storage_scope_sha256, ports.source_storage.approved_storage_scope_sha256);
  assert.equal(prepared.receipt.writes_performed, false);
});

test('exports only through the bound successor handoff and does not accept a non-root base port', () => {
  let supplied;
  const output = run({ env: { CFO_IDENTITY_REGISTRY_LEGACY_HANDOFF_JSON: JSON.stringify(legacy), CFO_IDENTITY_REGISTRY_PORTS_JSON: JSON.stringify(ports), CFO_IDENTITY_REGISTRY_SUCCESSOR_EXPIRES_AT: '2026-09-13T01:00:00.000Z' }, now, exporter: ({ env }) => { supplied = env; return { schema: 'cfo-identity-registry-exporter-task-v1', status: 'published', immutable_output_proof: { manifest: { sha256: 'f'.repeat(64) }, pointer: { sha256: 'e'.repeat(64) } } }; } });
  assert.equal(output.successor_storage_attestation.status, 'attested');
  assert.equal(JSON.parse(supplied.CFO_IDENTITY_REGISTRY_HANDOFF_JSON).export_input.prefix, JSON.parse(supplied.CFO_IDENTITY_REGISTRY_PORTS_JSON).source_storage.prefix);
  assert.throws(() => prepareSuccessorTask({ legacyHandoffJson: JSON.stringify(legacy), rootPortsJson: JSON.stringify({ ...ports, source_storage: { ...ports.source_storage, prefix: 'graph-trial/other' } }), expiresAt: '2026-09-13T01:00:00.000Z', now }), { code: 'identity_registry_exporter_ports_invalid' });
});