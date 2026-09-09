import { createHash, createPublicKey, verify } from 'node:crypto';

type IdentityAuthority = { schema: 'authenticated-structured-identity-authority-v1'; adapter_id: string; source_system: string; scope: 'cfo'; version: string };
export type IdentityVerificationConfig = { registry_id: string; authority: IdentityAuthority; public_key: string | Buffer };
type IdentityRegistryConfig = IdentityVerificationConfig;
const IDENTITY_REGISTRY_SCHEMA = 'source-identity-registry-v1';
const MAX_IDENTITY_ENVELOPE_BYTES = 256 * 1024;
const PARTITION_MANIFEST_SCHEMA = 'source-identity-registry-partition-manifest-v1';
const PARTITION_VERSION = /^sirm_[a-f0-9]{64}$/;
const PARTITION_PREFIX = /^[a-f0-9]{1,64}$/;
const SHA = /^[a-f0-9]{64}$/;
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string { if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';const row=value as Record<string,unknown>;return '{'+Object.keys(row).sort().map(key=>JSON.stringify(key)+':'+canonical(row[key])).join(',')+'}'; }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return !!value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value as Record<string,unknown>).sort().join('\0')===[...keys].sort().join('\0'); }
function bounded(value: unknown,max=240): value is string { return typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0'); }
function sameIdentityAuthority(value: unknown, expected: IdentityAuthority): boolean {
  return canonical(value) === canonical(expected);
}
function validIdentityRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !bounded((value as Record<string, unknown>).source_record_id) ||
      !bounded((value as Record<string, unknown>).source_document_version) ||
      !SHA.test(String((value as Record<string, unknown>).source_sha256)) ||
      !bounded((value as Record<string, unknown>).mention)) return false;
  const row = value as Record<string, unknown>;
  if (row.disposition === 'unresolved') {
    return exact(row, ['source_record_id','source_document_version','source_sha256','mention','disposition']);
  }
  if (row.disposition === 'revoked') {
    return exact(row, ['source_record_id','source_document_version','source_sha256','mention','disposition','revocation_id']) &&
      bounded(row.revocation_id);
  }
  if (row.disposition !== 'resolved' || !exact(row, [
    'source_record_id','source_document_version','source_sha256','mention','disposition','endpoint',
  ])) return false;
  const endpoint = row.endpoint as Record<string, unknown>;
  if (!exact(endpoint, ['display_name','entity_type','identifier']) || endpoint.display_name !== row.mention ||
      !bounded(endpoint.display_name) || !bounded(endpoint.entity_type) || !endpoint.identifier ||
      typeof endpoint.identifier !== 'object' || Array.isArray(endpoint.identifier)) return false;
  const identifier = endpoint.identifier as Record<string, unknown>;
  return exact(identifier, ['namespace','scope','value']) &&
    bounded(identifier.namespace) && bounded(identifier.scope) && bounded(identifier.value);
}
function identityRecordKey(record: Record<string, unknown>) {
  return canonical({ source_document_version: record.source_document_version,
    source_sha256: record.source_sha256, mention: record.mention });
}
export function validIdentityEnvelope(value: unknown, config: IdentityRegistryConfig, expectedVersion?: string): boolean {
  if (!exact(value, ['signature','snapshot']) || typeof value.signature !== 'string' ||
      value.signature.length !== 88 || !value.snapshot || typeof value.snapshot !== 'object') return false;
  const snapshot = value.snapshot as Record<string, unknown>;
  if (!exact(snapshot, ['entries','public_key_sha256','registry_id','revocations','schema',
    'source_authority','source_version','version']) || snapshot.schema !== IDENTITY_REGISTRY_SCHEMA ||
      snapshot.registry_id !== config.registry_id || !bounded(snapshot.version) ||
      (expectedVersion !== undefined && snapshot.version !== expectedVersion) ||
      !sameIdentityAuthority(snapshot.source_authority, config.authority) || !bounded(snapshot.source_version) ||
      !SHA.test(String(snapshot.public_key_sha256)) || !Array.isArray(snapshot.entries) ||
      !Array.isArray(snapshot.revocations) || snapshot.entries.length > 1000 || snapshot.revocations.length > 1000 ||
      Buffer.byteLength(canonical(value), 'utf8') > MAX_IDENTITY_ENVELOPE_BYTES) return false;
  let publicKey;
  try { publicKey = createPublicKey(config.public_key); } catch { return false; }
  if (publicKey.asymmetricKeyType !== 'ed25519' ||
      digest(publicKey.export({ type: 'spki', format: 'der' })) !== snapshot.public_key_sha256) return false;
  const entries = snapshot.entries as Record<string, unknown>[];
  const revocations = snapshot.revocations as Record<string, unknown>[];
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    if (!exact(entry, ['endpoint','mention','source_document_version','source_sha256']) ||
        !validIdentityRecord({ ...entry, source_record_id: 'snapshot', disposition: 'resolved' }) ||
        entryKeys.has(identityRecordKey(entry))) return false;
    entryKeys.add(identityRecordKey(entry));
  }
  const revocationKeys = new Set<string>();
  for (const revocation of revocations) {
    if (!exact(revocation, ['mention','revocation_id','source_document_version','source_record_id','source_sha256']) ||
        !validIdentityRecord({ ...revocation, disposition: 'revoked' }) ||
        revocationKeys.has(identityRecordKey(revocation)) || entryKeys.has(identityRecordKey(revocation))) return false;
    revocationKeys.add(identityRecordKey(revocation));
  }
  const version = 'sirv_' + digest(canonical({ registry_id: snapshot.registry_id,
    source_authority: snapshot.source_authority, source_version: snapshot.source_version,
    entries: snapshot.entries, revocations: snapshot.revocations }));
  if (snapshot.version !== version) return false;
  const signature = Buffer.from(value.signature, 'base64');
  return signature.length === 64 && verify(null, Buffer.from(canonical(snapshot), 'utf8'), publicKey, signature);
}
function partitionText(value: unknown): value is string { return bounded(value, 240); }
function partitionKey(config: IdentityRegistryConfig) {
  try {
    const key = createPublicKey(config.public_key);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch { return null; }
}
function partitionEnvelope(value: unknown, config: IdentityRegistryConfig, snapshotCheck: (snapshot: Record<string, unknown>) => boolean): boolean {
  if (!exact(value, ['snapshot','signature']) || typeof value.signature !== 'string' ||
      Buffer.byteLength(canonical(value), 'utf8') > MAX_IDENTITY_ENVELOPE_BYTES ||
      !value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) return false;
  const key = partitionKey(config);
  const signature = Buffer.from(value.signature, 'base64');
  return !!key && signature.length === 64 && snapshotCheck(value.snapshot as Record<string, unknown>) &&
    verify(null, Buffer.from(canonical(value.snapshot), 'utf8'), key, signature);
}
function partitionDescriptor(value: unknown): value is Record<string, unknown> {
  return exact(value, ['binding_count','binding_set_sha256','partition_prefix','registry_version','shard_id','snapshot_sha256','source_version']) &&
    partitionText(value.shard_id) && partitionText(value.registry_version) && partitionText(value.source_version) &&
    PARTITION_PREFIX.test(String(value.partition_prefix)) && SHA.test(String(value.snapshot_sha256)) && SHA.test(String(value.binding_set_sha256)) &&
    Number.isSafeInteger(value.binding_count) && Number(value.binding_count) >= 0 && Number(value.binding_count) <= 1000;
}
function completePartition(prefixes: string[]): boolean {
  const leaves = new Set(prefixes);
  const has = (prefix: string) => prefixes.some(value => value.startsWith(prefix));
  const covers = (prefix: string): boolean => leaves.has(prefix) ||
    (has(prefix) && '0123456789abcdef'.split('').every(nibble => covers(prefix + nibble)));
  return '0123456789abcdef'.split('').every(covers);
}
export function validPartitionManifest(value: unknown, config: IdentityRegistryConfig, expectedVersion: string): boolean {
  return partitionEnvelope(value, config, snapshot => {
    if (!exact(snapshot, ['catalog_coverage','public_key_sha256','registry_id','schema','shards','source_authority','source_generation','version']) ||
        snapshot.schema !== PARTITION_MANIFEST_SCHEMA || snapshot.registry_id !== config.registry_id || snapshot.version !== expectedVersion ||
        !PARTITION_VERSION.test(expectedVersion) || !sameIdentityAuthority(snapshot.source_authority, config.authority) ||
        !partitionText(snapshot.source_generation) || !SHA.test(String(snapshot.public_key_sha256)) || !Array.isArray(snapshot.shards) ||
        snapshot.shards.length < 1 || snapshot.shards.length > 1000 || !snapshot.shards.every(partitionDescriptor) ||
        digest(partitionKey(config)!.export({ type: 'spki', format: 'der' })) !== snapshot.public_key_sha256) return false;
    const coverage = snapshot.catalog_coverage as Record<string, unknown>;
    if (!exact(coverage, ['catalog_version','complete','coverage_sha256','expected_shard_count','schema','source_binding_count','source_binding_set_sha256']) ||
        coverage.schema !== 'source-identity-catalog-coverage-v1' || coverage.complete !== true || !partitionText(coverage.catalog_version) ||
        !SHA.test(String(coverage.coverage_sha256)) || !SHA.test(String(coverage.source_binding_set_sha256)) ||
        !Number.isSafeInteger(coverage.expected_shard_count) || Number(coverage.expected_shard_count) !== snapshot.shards.length ||
        !Number.isSafeInteger(coverage.source_binding_count) || Number(coverage.source_binding_count) < 0 || Number(coverage.source_binding_count) > 100000) return false;
    const shards = snapshot.shards as Record<string, unknown>[];
    const ids = new Set(shards.map(shard => String(shard.shard_id)));
    const prefixes = shards.map(shard => String(shard.partition_prefix));
    const sorted = [...shards].sort((left, right) => String(left.partition_prefix) < String(right.partition_prefix) ? -1 :
      String(left.partition_prefix) > String(right.partition_prefix) ? 1 : 0);
    const unsigned = { schema: PARTITION_MANIFEST_SCHEMA, registry_id: snapshot.registry_id, source_authority: snapshot.source_authority,
      source_generation: snapshot.source_generation, catalog_coverage: snapshot.catalog_coverage, shards: sorted,
      public_key_sha256: snapshot.public_key_sha256 };
    return ids.size === shards.length && new Set(prefixes).size === prefixes.length && completePartition(prefixes) &&
      shards.reduce((sum, shard) => sum + Number(shard.binding_count), 0) === Number(coverage.source_binding_count) &&
      !prefixes.some((prefix, i) => prefixes.some((other, j) => i !== j && other.startsWith(prefix))) &&
      expectedVersion === 'sirm_' + digest(canonical(unsigned)) && canonical(snapshot) === canonical({ ...unsigned, version: expectedVersion });
  });
}
function bindingSetHash(values: string[]): string { return digest(canonical([...values].sort())); }
export function validPartitionShard(value: unknown, config: IdentityRegistryConfig, manifest: Record<string, unknown>, descriptor: Record<string, unknown>): boolean {
  return partitionEnvelope(value, config, snapshot => {
    if (!exact(snapshot, ['entries','partition_binding_hashes','public_key_sha256','registry_id','revocations','schema','source_authority','source_version','version']) ||
        snapshot.schema !== IDENTITY_REGISTRY_SCHEMA || snapshot.registry_id !== config.registry_id ||
        snapshot.version !== descriptor.registry_version || snapshot.source_version !== descriptor.source_version ||
        !sameIdentityAuthority(snapshot.source_authority, config.authority) ||
        snapshot.public_key_sha256 !== manifest.public_key_sha256 || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.revocations) ||
        snapshot.entries.length > 1000 || snapshot.revocations.length > 1000 || !Array.isArray(snapshot.partition_binding_hashes) ||
        snapshot.partition_binding_hashes.length !== descriptor.binding_count || snapshot.partition_binding_hashes.some(hash => !SHA.test(String(hash))) ||
        new Set(snapshot.partition_binding_hashes).size !== snapshot.partition_binding_hashes.length ||
        bindingSetHash(snapshot.partition_binding_hashes as string[]) !== descriptor.binding_set_sha256 ||
        (snapshot.partition_binding_hashes as string[]).some(hash => !hash.startsWith(String(descriptor.partition_prefix))) ||
        digest(canonical(snapshot)) !== descriptor.snapshot_sha256) return false;
    const records = [...snapshot.entries as unknown[], ...snapshot.revocations as unknown[]];
    return records.every(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record) || !partitionText((record as Record<string, unknown>).source_document_version) ||
          !SHA.test(String((record as Record<string, unknown>).source_sha256)) || !partitionText((record as Record<string, unknown>).mention)) return false;
      const binding = digest(canonical({ source_document_version: (record as Record<string, unknown>).source_document_version,
        source_sha256: (record as Record<string, unknown>).source_sha256 }));
      return (snapshot.partition_binding_hashes as string[]).includes(binding);
    });
  });
}

export const identityRegistryVerification=Object.freeze({validIdentityEnvelope,validPartitionManifest,validPartitionShard});
