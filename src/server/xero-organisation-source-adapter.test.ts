import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createExplicitExportImmutableStore } from './identity-registry-explicit-export-ports.js';
import {
  bindImmutableXeroOrganisationProjection,
  canonicalXeroOrganisationProjection,
  publishXeroOrganisationExportHandoff,
  persistProvisionedXeroOrganisationSource,
  projectXeroOrganisation,
} from './xero-organisation-source-adapter.js';

const { buildExportInput } = await import('../../tools/xero-organisation-source-handoff-run.mjs');
const { runXeroOrganisationExplicitExport } = await import('../../tools/xero-organisation-explicit-export-run.mjs');

const response = (overrides: Record<string, unknown> = {}) => ({
  Organisations: [{
    OrganisationID: 'org-native-001',
    LegalName: 'Synthetic Corporate Master',
    Name: 'Synthetic Corporate Master',
    OrganisationEntityType: 'COMPANY',
    OrganisationStatus: 'ACTIVE',
    CreatedDateUTC: '2026-09-12T00:00:00.000Z',
    TaxNumber: 'must-not-propagate',
    Addresses: [{ AddressLine1: 'must-not-propagate' }],
    Phones: [{ PhoneNumber: 'must-not-propagate' }],
    ...overrides,
  }],
});

test('projects only the company-safe organisation fields and binds a canonical immutable payload', () => {
  const projection = projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response() });
  assert.deepEqual(Object.keys(projection).sort(), [
    'created_date_utc', 'entity_type', 'mention', 'organisation_id', 'schema', 'status', 'tenant_id',
  ]);
  const pinned = canonicalXeroOrganisationProjection(projection);
  const bound = bindImmutableXeroOrganisationProjection({
    projection, sourceDocumentVersion: 's3-version-synthetic-001', sourceSha256: pinned.sha256,
  });
  assert.equal(bound.record.endpoint.identifier.namespace, 'xero.accounting.organisation');
  assert.equal(bound.record.endpoint.identifier.scope, 'tenant-native-001');
  assert.equal(bound.record.endpoint.identifier.value, 'org-native-001');
  assert.equal(bound.record.source_sha256, pinned.sha256);
  assert.equal(bound.receipt.raw_response_persisted, false);
  assert.ok(!Object.hasOwn(projection, 'TaxNumber'));
  assert.ok(!Object.hasOwn(projection, 'Addresses'));
  assert.ok(!Object.hasOwn(projection, 'Phones'));
  const exactMention = projectXeroOrganisation({
    tenantId: 'tenant-native-001', response: response({ LegalName: 'Synthetic  Corporate Master' }),
  });
  assert.equal(exactMention.mention, 'Synthetic  Corporate Master');
});

test('rejects personal, inactive, ambiguous, and mismatched immutable inputs', () => {
  assert.throws(() => projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response({ OrganisationEntityType: 'INDIVIDUAL' }) }), { code: 'xero_organisation_not_company' });
  assert.throws(() => projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response({ OrganisationStatus: 'ARCHIVED' }) }), { code: 'xero_organisation_not_active' });
  assert.throws(() => projectXeroOrganisation({ tenantId: 'tenant-native-001', response: { Organisations: [] } }), { code: 'xero_organisation_cardinality_invalid' });
  const projection = projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response() });
  assert.throws(() => bindImmutableXeroOrganisationProjection({ projection, sourceDocumentVersion: 's3-version-synthetic-001', sourceSha256: '0'.repeat(64) }), { code: 'xero_source_sha256_mismatch' });
});

test('public projection boundaries reject forged JSON shapes before canonicalization or binding', () => {
  const valid = projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response() });
  const forgedExtra = JSON.parse(JSON.stringify({ ...valid, TaxNumber: 'forged-extra-field' }));
  const forgedStatus = JSON.parse(JSON.stringify({ ...valid, status: 'INACTIVE' }));
  const forgedControl = JSON.parse(JSON.stringify({ ...valid, mention: 'Synthetic\nCorporate Master' }));
  const forgedCreated = JSON.parse(JSON.stringify({ ...valid, created_date_utc: 1 }));
  for (const projection of [forgedExtra, forgedStatus, forgedControl, forgedCreated]) {
    assert.throws(() => canonicalXeroOrganisationProjection(projection), { code: 'xero_organisation_projection_invalid' });
    assert.throws(() => bindImmutableXeroOrganisationProjection({
      projection, sourceDocumentVersion: 's3-version-synthetic-001', sourceSha256: '0'.repeat(64),
    }), { code: 'xero_organisation_projection_invalid' });
  }
});

const prefix = 'graph-trial/20260912/identity-registry/cfo-pilot/source';
const policyHash = 'a'.repeat(64);
const deployment = () => ({
  org: 'otchealth' as const,
  source_storage: {
    bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix, region: 'us-east-1',
    approvedPolicyCanonicalSha256: policyHash,
    approvedStorageScopeSha256: createHash('sha256').update(JSON.stringify({
      bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix, policy_sha256: policyHash,
    })).digest('hex'),
    operationTimeoutMs: 1000,
    sse: { algorithm: 'AES256' as const },
  },
});

function immutableStore(mode: 'ok' | 'corrupt-bytes' | 'corrupt-version') {
  let body: Buffer | undefined;
  const headers = (version: string) => new Headers({
    'x-amz-server-side-encryption': 'AES256', 'x-amz-version-id': version,
  });
  return (config: Parameters<typeof createExplicitExportImmutableStore>[0]) => createExplicitExportImmutableStore({
    ...config,
    createRuntime: () => ({
      preflight: async () => ({ bucket: config.bucket, prefix: config.prefix, canonical_policy_sha256: config.approvedPolicyCanonicalSha256 }),
      request: async request => {
        if (request.method === 'PUT') { body = Buffer.from(request.body!, 'utf8'); return { status: 201, headers: headers('version-1'), body: Buffer.alloc(0) }; }
        if (!body) return { status: 404, headers: new Headers(), body: Buffer.alloc(0) };
        return {
          status: 200,
          headers: headers(mode === 'corrupt-version' ? 'version-2' : 'version-1'),
          body: mode === 'corrupt-bytes' ? Buffer.from('{"forged":true}') : body,
        };
      },
    }) as never,
  });
}

const sourceOwnerDeps = (mode: 'ok' | 'corrupt-bytes' | 'corrupt-version') => ({
  getOrganisation: async () => ({
    status: 200, body: response(), tenantId: 'tenant-native-001', dayLimitRemaining: null, minuteLimitRemaining: null,
  }),
  createImmutableStore: immutableStore(mode),
});

test('uses the source-owned Xero connector and readback-verified immutable writer', async () => {
  const result = await persistProvisionedXeroOrganisationSource({
    ...deployment(),
  }, sourceOwnerDeps('ok'));
  assert.equal(result.record.source_document_version, 'version-1');
  assert.equal(result.record.source_sha256, canonicalXeroOrganisationProjection(result.projection).sha256);
  for (const mode of ['corrupt-bytes', 'corrupt-version'] as const) {
    await assert.rejects(persistProvisionedXeroOrganisationSource({ ...deployment() }, sourceOwnerDeps(mode)), { code: 'identity_export_store_invalid' });
  }
  await assert.rejects(persistProvisionedXeroOrganisationSource({ ...deployment() }, {
    getOrganisation: async () => ({
      status: 304, body: response(), tenantId: 'tenant-native-001', dayLimitRemaining: null, minuteLimitRemaining: null,
    }),
    createImmutableStore: immutableStore('ok'),
  }), { code: 'xero_organisation_connector_response_invalid' });
  await assert.rejects(persistProvisionedXeroOrganisationSource({
    ...deployment(), source_storage: { ...deployment().source_storage, prefix: 'graph-trial/not-approved' },
  }, sourceOwnerDeps('ok')), { code: 'xero_organisation_deployment_invalid' });
});

test('publishes an immutable metadata-only cross-task exporter handoff', async () => {
  const projection = projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response() });
  const pin = canonicalXeroOrganisationProjection(projection);
  const bound = bindImmutableXeroOrganisationProjection({ projection, sourceDocumentVersion: 'source-version-1', sourceSha256: pin.sha256 });
  let written: Readonly<{ key: string; body: Buffer }> | undefined;
  const result = await publishXeroOrganisationExportHandoff({
    sourceStorage: deployment().source_storage,
    record: bound.record,
    exportInput: { registry_id: 'synthetic-registry', prefix: 'graph-trial/20260912/identity-registry/cfo-pilot/snapshots' },
    writer: { putImmutable: async value => { written = value; return { version_id: 'handoff-version-1' }; } },
  });
  assert.ok(written);
  assert.equal(written!.key, `${prefix}/identity-registries/xero-organisation/handoffs/${result.sha256}.json`);
  assert.notEqual(result.sha256, pin.sha256);
  assert.equal(result.handoff.source.version_id, 'source-version-1');
  assert.equal(result.handoff.source.sha256, pin.sha256);
  assert.equal(result.version_id, 'handoff-version-1');
  assert.ok(!written!.body.toString('utf8').includes('TaxNumber'));
});

test('retries an exact source handoff and exports each renewed handoff through the real parser', async () => {
  const projection = projectXeroOrganisation({ tenantId: 'tenant-native-001', response: response() });
  const pin = canonicalXeroOrganisationProjection(projection);
  const bound = bindImmutableXeroOrganisationProjection({ projection, sourceDocumentVersion: 'source-version-1', sourceSha256: pin.sha256 });
  const originalNow = Date.now, now = originalNow();
  let firstInput: Record<string, unknown>, sameClockInput: Record<string, unknown>, renewedInput: Record<string, unknown>;
  try {
    Date.now = () => now;
    firstInput = buildExportInput(bound.record);
    sameClockInput = buildExportInput(bound.record);
    Date.now = () => now + 2_000;
    renewedInput = buildExportInput(bound.record);
  } finally { Date.now = originalNow; }
  assert.deepEqual(sameClockInput!, firstInput!);
  assert.notEqual(firstInput!.expires_at, renewedInput!.expires_at);

  const objects = new Map<string, Readonly<{ body: Buffer; version_id: string }>>();
  let sequence = 0;
  const writer = {
    putImmutable: async ({ key, body }: Readonly<{ key: string; body: Buffer }>) => {
      const existing = objects.get(key);
      if (existing) { assert.deepEqual(existing.body, body); return { version_id: existing.version_id }; }
      const value = Object.freeze({ body: Buffer.from(body), version_id: `v-${++sequence}` });
      objects.set(key, value); return { version_id: value.version_id };
    },
  };
  const first = await publishXeroOrganisationExportHandoff({ sourceStorage: deployment().source_storage, record: bound.record, exportInput: firstInput!, writer });
  const retry = await publishXeroOrganisationExportHandoff({ sourceStorage: deployment().source_storage, record: bound.record, exportInput: sameClockInput!, writer });
  const renewed = await publishXeroOrganisationExportHandoff({ sourceStorage: deployment().source_storage, record: bound.record, exportInput: renewedInput!, writer });
  assert.equal(retry.key, first.key);
  assert.equal(retry.version_id, first.version_id);
  assert.notEqual(renewed.key, first.key);
  assert.equal(first.handoff.source.sha256, renewed.handoff.source.sha256);
  assert.equal(objects.size, 2);

  const targetPrefix = String(firstInput!.prefix);
  const scope = createHash('sha256').update(JSON.stringify({ bucket: deployment().source_storage.bucket, prefix: targetPrefix, policy_sha256: policyHash })).digest('hex');
  const ports = {
    schema: 'cfo-identity-registry-explicit-export-ports-v1',
    kms: { region: 'us-east-1', key_id: 'arn:aws:kms:us-east-1:900915535335:key/00000000-0000-0000-0000-000000000000' },
    source_storage: {
      bucket: deployment().source_storage.bucket, prefix: targetPrefix, region: 'us-east-1',
      approved_policy_canonical_sha256: policyHash, approved_storage_scope_sha256: scope, sse: { algorithm: 'AES256' },
    },
  };
  const keys = generateKeyPairSync('ed25519');
  const exportObjects = new Map<string, Readonly<{ body: Buffer; version_id: string }>>();
  let exportedSequence = 0, output: string | undefined;
  const result = await runXeroOrganisationExplicitExport({
    argv: ['--handoff', 'C:\\handoff.json', '--ports', 'C:\\ports.json', '--output', 'C:\\result.json'],
    read: async path => path.endsWith('handoff.json') ? JSON.stringify(first.handoff) : JSON.stringify(ports),
    write: async (_path, value) => { output = value; },
    runtimeFactory: () => ({
      preflight: async () => undefined,
      request: async () => ({ status: 200, headers: new Headers({ 'x-amz-version-id': bound.record.source_document_version, 'x-amz-server-side-encryption': 'AES256' }), body: Buffer.from(pin.payload, 'utf8') }),
    }),
    bind: bindImmutableXeroOrganisationProjection,
    signerFactory: async () => ({ publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), maxMessageBytes: 4096, sign: async bytes => sign(null, bytes, keys.privateKey) }),
    storeFactory: () => ({
      maxVersionIdBytes: 128,
      putImmutable: async ({ key, body }: Readonly<{ key: string; body: Buffer }>) => {
        const existing = exportObjects.get(key);
        if (existing) { assert.deepEqual(existing.body, body); return { version_id: existing.version_id }; }
        const value = Object.freeze({ body: Buffer.from(body), version_id: `export-${++exportedSequence}` });
        exportObjects.set(key, value); return { version_id: value.version_id };
      },
    }),
  });
  assert.deepEqual(result, { output_written: true });
  assert.equal(JSON.parse(output!).receipt.coverage_binding_count, 1);
  assert.equal(exportObjects.size, 5);
});
