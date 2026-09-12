import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const IMMUTABLE_KEY = /^graph-trial\/identity-registry\/xero-organisation\/[A-Za-z0-9._/-]{1,900}$/;
const PROJECTION_KEYS = [
  'created_date_utc', 'entity_type', 'mention', 'organisation_id', 'schema', 'status', 'tenant_id',
] as const;

export type XeroOrganisationSafeProjection = Readonly<{
  schema: 'cfo-xero-organisation-safe-projection-v1';
  tenant_id: string;
  organisation_id: string;
  mention: string;
  entity_type: 'COMPANY';
  status: 'ACTIVE';
  created_date_utc: string | null;
}>;

export type XeroOrganisationSourceRecord = Readonly<{
  source_record_id: string;
  source_document_version: string;
  source_sha256: string;
  mention: string;
  disposition: 'resolved';
  endpoint: Readonly<{
    display_name: string;
    entity_type: 'COMPANY';
    identifier: Readonly<{
      namespace: 'xero.accounting.organisation';
      scope: string;
      value: string;
    }>;
  }>;
}>;

export type XeroOrganisationMetadataReceipt = Readonly<{
  schema: 'cfo-xero-organisation-source-receipt-v1';
  source_system: 'xero-accounting';
  endpoint: '/Organisation';
  company_only_gate: true;
  active_only_gate: true;
  native_id_field: 'OrganisationID';
  mention_field: 'LegalName|Name';
  identifier_namespace: 'xero.accounting.organisation';
  source_sha256: string;
  source_document_version: string;
  raw_response_persisted: false;
}>;

/**
 * The connector and writer are provisioned by CTO. This receipt contains no
 * credential material and makes the integration fail closed until that work
 * has been independently verified.
 */
export type XeroOrganisationProvisioningReceipt = Readonly<{
  schema: 'cfo-xero-organisation-source-provisioning-receipt-v1';
  status: 'verified';
  source_connector: 'verified';
  immutable_writer: 'verified';
}>;

export type XeroOrganisationSourceConnector = Readonly<{
  getOrganisation(): Promise<Readonly<{ tenantId: string; response: unknown }>>;
}>;

export type XeroOrganisationImmutableWriter = Readonly<{
  putImmutable(input: Readonly<{ key: string; body: Buffer }>): Promise<Readonly<{ version_id: string }>>;
}>;

type Organisation = Readonly<Record<string, unknown>>;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value.trim() === value && !/[\p{C}]/u.test(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function checkedProjection(value: unknown): XeroOrganisationSafeProjection {
  if (!exact(value, PROJECTION_KEYS) || value.schema !== 'cfo-xero-organisation-safe-projection-v1' ||
      !text(value.tenant_id) || !text(value.organisation_id) || !text(value.mention) ||
      value.entity_type !== 'COMPANY' || value.status !== 'ACTIVE' ||
      !(value.created_date_utc === null || text(value.created_date_utc))) {
    fail('xero_organisation_projection_invalid');
  }
  return value as XeroOrganisationSafeProjection;
}

function checkedProvisioning(value: unknown): XeroOrganisationProvisioningReceipt {
  if (!exact(value, ['immutable_writer', 'schema', 'source_connector', 'status']) ||
      value.schema !== 'cfo-xero-organisation-source-provisioning-receipt-v1' ||
      value.status !== 'verified' || value.source_connector !== 'verified' ||
      value.immutable_writer !== 'verified') {
    fail('xero_organisation_provisioning_unverified');
  }
  return value as XeroOrganisationProvisioningReceipt;
}

function checkedImmutableKey(value: unknown): string {
  if (typeof value !== 'string' || !IMMUTABLE_KEY.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('xero_organisation_immutable_key_invalid');
  }
  return value;
}

function singleOrganisation(value: unknown): Organisation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('xero_organisation_envelope_invalid');
  const organisations = (value as Record<string, unknown>).Organisations;
  if (!Array.isArray(organisations) || organisations.length !== 1) fail('xero_organisation_cardinality_invalid');
  const item = organisations[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('xero_organisation_record_invalid');
  return item as Organisation;
}

/**
 * Produces a minimal corporate-only projection. It deliberately ignores all
 * finance, tax, address, phone, API-key, and payment fields in Xero's reply.
 * It neither writes storage nor logs raw source values.
 */
export function projectXeroOrganisation(input: Readonly<{ tenantId: string; response: unknown }>): XeroOrganisationSafeProjection {
  if (!text(input.tenantId)) fail('xero_tenant_id_invalid');
  const organisation = singleOrganisation(input.response);
  const organisationId = organisation.OrganisationID;
  const legalName = organisation.LegalName;
  const name = organisation.Name;
  const mention = text(legalName) ? legalName : text(name) ? name : null;
  if (!text(organisationId) || !mention) fail('xero_organisation_identity_invalid');
  if (organisation.OrganisationEntityType !== 'COMPANY') fail('xero_organisation_not_company');
  if (organisation.OrganisationStatus !== 'ACTIVE') fail('xero_organisation_not_active');
  const created = organisation.CreatedDateUTC;
  if (created !== undefined && !text(created)) fail('xero_organisation_created_at_invalid');
  return Object.freeze({
    schema: 'cfo-xero-organisation-safe-projection-v1',
    tenant_id: input.tenantId,
    organisation_id: organisationId,
    mention,
    entity_type: 'COMPANY',
    status: 'ACTIVE',
    created_date_utc: created ?? null,
  });
}

/** Content-addressed immutable payload for the source-owner storage writer. */
export function canonicalXeroOrganisationProjection(projection: unknown): Readonly<{ payload: string; sha256: string }> {
  const payload = canonical(checkedProjection(projection));
  return Object.freeze({ payload, sha256: hash(payload) });
}

/**
 * Binds the already-written immutable object to the explicit identity record.
 * The storage writer supplies the opaque object version after a conditional,
 * read-back-verified write. This module never performs that write itself.
 */
export function bindImmutableXeroOrganisationProjection(input: Readonly<{
  projection: unknown;
  sourceDocumentVersion: string;
  sourceSha256: string;
}>): Readonly<{ record: XeroOrganisationSourceRecord; receipt: XeroOrganisationMetadataReceipt }> {
  if (!text(input.sourceDocumentVersion)) fail('xero_source_document_version_invalid');
  if (!HASH.test(input.sourceSha256)) fail('xero_source_sha256_invalid');
  const projection = checkedProjection(input.projection);
  const expected = canonicalXeroOrganisationProjection(projection).sha256;
  if (input.sourceSha256 !== expected) fail('xero_source_sha256_mismatch');
  const record: XeroOrganisationSourceRecord = Object.freeze({
    source_record_id: projection.organisation_id,
    source_document_version: input.sourceDocumentVersion,
    source_sha256: input.sourceSha256,
    mention: projection.mention,
    disposition: 'resolved',
    endpoint: Object.freeze({
      display_name: projection.mention,
      entity_type: 'COMPANY',
      identifier: Object.freeze({
        namespace: 'xero.accounting.organisation',
        scope: projection.tenant_id,
        value: projection.organisation_id,
      }),
    }),
  });
  const receipt: XeroOrganisationMetadataReceipt = Object.freeze({
    schema: 'cfo-xero-organisation-source-receipt-v1',
    source_system: 'xero-accounting',
    endpoint: '/Organisation',
    company_only_gate: true,
    active_only_gate: true,
    native_id_field: 'OrganisationID',
    mention_field: 'LegalName|Name',
    identifier_namespace: 'xero.accounting.organisation',
    source_sha256: input.sourceSha256,
    source_document_version: input.sourceDocumentVersion,
    raw_response_persisted: false,
  });
  return Object.freeze({ record, receipt });
}

/**
 * The source-owner integration point. It reads the tenant's Organisation
 * metadata through a provisioned connector, writes only the safe canonical
 * projection through a conditional immutable writer, and binds the returned
 * opaque version. It is inert until a verified provisioning receipt is passed.
 */
export async function persistProvisionedXeroOrganisationSource(input: Readonly<{
  provisioning: unknown;
  connector: XeroOrganisationSourceConnector;
  writer: XeroOrganisationImmutableWriter;
  immutableKey: string;
}>): Promise<Readonly<{
  projection: XeroOrganisationSafeProjection;
  record: XeroOrganisationSourceRecord;
  receipt: XeroOrganisationMetadataReceipt;
}>> {
  checkedProvisioning(input.provisioning);
  const key = checkedImmutableKey(input.immutableKey);
  if (!input.connector || typeof input.connector.getOrganisation !== 'function' ||
      !input.writer || typeof input.writer.putImmutable !== 'function') {
    fail('xero_organisation_integration_invalid');
  }
  const source = await input.connector.getOrganisation();
  if (!source || typeof source !== 'object' || Array.isArray(source) || !exact(source, ['response', 'tenantId'])) {
    fail('xero_organisation_connector_response_invalid');
  }
  const projection = projectXeroOrganisation(source);
  const pinned = canonicalXeroOrganisationProjection(projection);
  const written = await input.writer.putImmutable({ key, body: Buffer.from(pinned.payload, 'utf8') });
  if (!written || typeof written !== 'object' || Array.isArray(written) || !exact(written, ['version_id']) || !text(written.version_id)) {
    fail('xero_organisation_immutable_write_invalid');
  }
  const bound = bindImmutableXeroOrganisationProjection({
    projection,
    sourceDocumentVersion: written.version_id,
    sourceSha256: pinned.sha256,
  });
  return Object.freeze({ projection, ...bound });
}
