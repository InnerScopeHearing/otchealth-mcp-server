import assert from 'node:assert/strict';
import test from 'node:test';
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

test('writes only the safe canonical projection after independent provisioning verification', async () => {
  let written: Readonly<{ key: string; body: Buffer }> | undefined;
  const result = await persistProvisionedXeroOrganisationSource({
    provisioning: {
      schema: 'cfo-xero-organisation-source-provisioning-receipt-v1',
      status: 'verified', source_connector: 'verified', immutable_writer: 'verified',
    },
    connector: { getOrganisation: async () => ({ tenantId: 'tenant-native-001', response: response() }) },
    writer: { putImmutable: async request => { written = request; return { version_id: 's3-version-synthetic-001' }; } },
    immutableKey: 'graph-trial/identity-registry/xero-organisation/tenant-native-001.json',
  });
  assert.ok(written);
  assert.equal(written!.key, 'graph-trial/identity-registry/xero-organisation/tenant-native-001.json');
  assert.equal(written!.body.toString('utf8'), canonicalXeroOrganisationProjection(result.projection).payload);
  assert.equal(result.record.source_document_version, 's3-version-synthetic-001');
  await assert.rejects(persistProvisionedXeroOrganisationSource({
    provisioning: { schema: 'cfo-xero-organisation-source-provisioning-receipt-v1', status: 'pending', source_connector: 'verified', immutable_writer: 'verified' } as never,
    connector: { getOrganisation: async () => { throw Error('must not run'); } },
    writer: { putImmutable: async () => { throw Error('must not run'); } },
    immutableKey: 'graph-trial/identity-registry/xero-organisation/tenant-native-001.json',
  }), { code: 'xero_organisation_provisioning_unverified' });
});
