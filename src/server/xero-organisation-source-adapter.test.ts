import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createExplicitExportImmutableStore } from './identity-registry-explicit-export-ports.js';
import {
  bindImmutableXeroOrganisationProjection,
  canonicalXeroOrganisationProjection,
  persistProvisionedXeroOrganisationSource,
  projectXeroOrganisation,
} from './xero-organisation-source-adapter.js';

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
  await assert.rejects(persistProvisionedXeroOrganisationSource({
    ...deployment(), source_storage: { ...deployment().source_storage, prefix: 'graph-trial/not-approved' },
  }, sourceOwnerDeps('ok')), { code: 'xero_organisation_deployment_invalid' });
});
