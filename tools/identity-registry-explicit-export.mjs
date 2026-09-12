import { createHash, createPublicKey } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,191}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,1023}$/;
const VERSION = /^[A-Za-z0-9._~+/-]{1,1024}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const canonicalJson = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonicalJson).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
const exact = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const text = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\s]/.test(value);
const validKey = key => typeof key === 'string' && KEY.test(key) && key.split('/').every(part => part && part !== '.' && part !== '..');
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

function validAuthority(value) { return exact(value, ['adapter_id', 'schema', 'scope', 'source_system', 'version']) && value.schema === 'authenticated-structured-identity-authority-v1' && value.scope === 'cfo' && text(value.adapter_id) && text(value.source_system) && text(value.version); }
function validRun(value) {
  if (!exact(value, ['manifest_sha256', 'purpose', 'ref_version', 'run_id', 'run_version', 'scope'])) return false;
  const unsigned = { ref_version: value.ref_version, purpose: value.purpose, scope: value.scope, run_version: value.run_version, manifest_sha256: value.manifest_sha256 };
  return value.ref_version === 'neptune-trial-active-run-ref-v1' && value.scope === 'finance' && text(value.purpose) && text(value.run_version) && HASH.test(value.manifest_sha256) && value.run_id === 'run_' + digest(unsigned);
}
function validEndpoint(value, mention) { return exact(value, ['display_name', 'entity_type', 'identifier']) && value.display_name === mention && text(value.entity_type) && value.identifier && typeof value.identifier === 'object' && !Array.isArray(value.identifier) && exact(value.identifier, ['namespace', 'scope', 'value']) && text(value.identifier.namespace) && text(value.identifier.scope) && text(value.identifier.value); }
function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !text(value.source_record_id) || !text(value.source_document_version) || !HASH.test(value.source_sha256) || !text(value.mention)) return false;
  if (value.disposition === 'unresolved') return exact(value, ['disposition', 'mention', 'source_document_version', 'source_record_id', 'source_sha256']);
  if (value.disposition === 'revoked') return exact(value, ['disposition', 'mention', 'revocation_id', 'source_document_version', 'source_record_id', 'source_sha256']) && text(value.revocation_id);
  return value.disposition === 'resolved' && exact(value, ['disposition', 'endpoint', 'mention', 'source_document_version', 'source_record_id', 'source_sha256']) && validEndpoint(value.endpoint, value.mention);
}
function bindingHash(binding) {
  if (!exact(binding, ['chunk_sha256', 'source_document_version']) || !text(binding.source_document_version) || !HASH.test(binding.chunk_sha256)) fail('identity_export_binding_invalid');
  return digest({ source_document_version: binding.source_document_version, source_sha256: binding.chunk_sha256 });
}
function signed(snapshot, signer) { return Promise.resolve(signer.sign(Buffer.from(canonicalJson(snapshot), 'utf8'))).then(signature => {
  if (!Buffer.isBuffer(signature) || signature.length !== 64) fail('identity_export_signature_invalid');
  return { snapshot, signature: signature.toString('base64') };
}); }

/**
 * Publishes an explicit-ID source export through injected CFO-owned ports.
 * `signer` exposes only a public key and sign(bytes); private material remains
 * in the caller's approved secrets store. `store` must be immutable and return
 * the assigned object version after each write.
 */
export async function publishExplicitIdentityRegistryExport({ input, signer, store }) {
  if (!input || !exact(input, ['authority', 'bindings', 'catalog', 'expires_at', 'partition_manifest_version', 'prefix', 'records', 'registry_id', 'run', 'shards', 'source_generation', 'source_version'])) fail('identity_export_input_invalid');
  if (!LABEL.test(input.registry_id) || !validAuthority(input.authority) || !validRun(input.run) || !exact(input.catalog, ['catalog_sha256', 'catalog_version']) || !text(input.catalog.catalog_version) || !HASH.test(input.catalog.catalog_sha256) || !/^sirm_[a-f0-9]{64}$/.test(input.partition_manifest_version) || !text(input.source_generation) || !text(input.source_version) || !validKey(input.prefix) || !input.prefix.startsWith('graph-trial/') || !Array.isArray(input.records) || !Array.isArray(input.bindings) || !Array.isArray(input.shards) || input.records.length > 100000 || input.bindings.length > 100000 || input.shards.length < 1 || input.shards.length > 1000 || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.now() + 1000) fail('identity_export_input_invalid');
  if (!signer || typeof signer.sign !== 'function' || typeof signer.publicKey !== 'string') fail('identity_export_signer_invalid');
  let key;
  try { key = createPublicKey(signer.publicKey); } catch { fail('identity_export_signer_invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('identity_export_signer_invalid');
  if (!store || typeof store.putImmutable !== 'function') fail('identity_export_store_invalid');
  if (!input.records.every(validRecord)) fail('identity_export_record_not_explicit');
  const bindingHashes = input.bindings.map(bindingHash).sort();
  if (new Set(bindingHashes).size !== bindingHashes.length) fail('identity_export_binding_duplicate');
  const knownBindings = new Set(bindingHashes);
  if (input.records.some(record => !knownBindings.has(digest({ source_document_version: record.source_document_version, source_sha256: record.source_sha256 })))) fail('identity_export_record_binding_missing');
  const prefix = input.prefix, pageRows = chunks(input.records, 1000), coverageRows = chunks(bindingHashes, 1000);
  if (!pageRows.length || !coverageRows.length) fail('identity_export_input_empty');
  const put = async (keyName, value) => {
    if (!validKey(keyName) || !keyName.startsWith(prefix + '/')) fail('identity_export_key_invalid');
    const body = Buffer.from(canonicalJson(value), 'utf8');
    const written = await store.putImmutable({ key: keyName, body });
    if (!written || !VERSION.test(written.version_id) || written.version_id === 'null') fail('identity_export_store_invalid');
    return { key: keyName, version_id: written.version_id, sha256: digest(body) };
  };
  const pages = [];
  for (let index = 0; index < pageRows.length; index++) {
    const cursor = index === 0 ? null : `page-${index}`;
    const value = { schema: 'structured-identity-source-page-v1', authority: input.authority, current: true, source_version: input.source_version, records: pageRows[index], next_cursor: index + 1 < pageRows.length ? `page-${index + 1}` : null };
    const pin = await put(`${prefix}/pages/${index}.json`, value);
    pages.push({ cursor, ...pin, source_version: input.source_version });
  }
  const coverage_pages = [];
  for (let index = 0; index < coverageRows.length; index++) {
    const cursor = index === 0 ? null : `coverage-${index}`;
    const value = { schema: 'source-identity-catalog-coverage-page-v1', source_generation: input.source_generation, catalog_version: input.catalog.catalog_version, coverage_sha256: input.catalog.catalog_sha256, binding_hashes: coverageRows[index], next_cursor: index + 1 < coverageRows.length ? `coverage-${index + 1}` : null };
    const pin = await put(`${prefix}/coverage/${index}.json`, value);
    coverage_pages.push({ cursor, ...pin, source_version: input.source_version });
  }
  const shards = [];
  for (const item of input.shards) {
    if (!exact(item, ['registry_version', 'shard_id']) || !text(item.shard_id) || !text(item.registry_version)) fail('identity_export_shard_invalid');
    const current = { schema: 'source-identity-registry-explicit-export-shard-current-v1', registry_id: input.registry_id, partition_manifest_version: input.partition_manifest_version, shard_id: item.shard_id, registry_version: item.registry_version, source_version: input.source_version, source_generation: input.source_generation, current: true };
    const pin = await put(`${prefix}/shards/${item.shard_id}.json`, current);
    shards.push({ shard_id: item.shard_id, ...pin, registry_version: item.registry_version, source_version: input.source_version });
  }
  const public_key_sha256 = digest(key.export({ type: 'spki', format: 'der' }));
  const unsigned = { registry_id: input.registry_id, source_authority: input.authority, run: input.run, catalog: input.catalog, partition_manifest_version: input.partition_manifest_version, source_generation: input.source_generation, pages, coverage_pages, shards, coverage_binding_count: bindingHashes.length, coverage_binding_sha256: digest(bindingHashes), public_key_sha256 };
  const manifest = await signed({ schema: 'source-identity-registry-explicit-export-manifest-v1', ...unsigned, version: 'siex_' + digest(unsigned) }, signer);
  const manifestPin = await put(`${prefix}/exports/manifest.json`, manifest);
  const pointer = await signed({ schema: 'source-identity-registry-explicit-export-current-v1', registry_id: input.registry_id, manifest_version: manifest.snapshot.version, source_generation: input.source_generation, expires_at: input.expires_at, revoked: false }, signer);
  const pointerPin = await put(`${prefix}/exports/current.json`, pointer);
  return Object.freeze({
    public_config: Object.freeze({ registry_id: input.registry_id, authority: input.authority, binding: { authenticated_caller: 'cfo', room: 'finance', source_index: 'finance-cfo-source-docs', run: input.run }, public_key: signer.publicKey, partition_manifest_version: input.partition_manifest_version, source: { prefix, manifest: manifestPin, pointer: { key: pointerPin.key }, catalog: input.catalog } }),
    receipt: Object.freeze({ schema: 'source-identity-registry-explicit-export-receipt-v1', registry_id: input.registry_id, manifest_version: manifest.snapshot.version, source_generation: input.source_generation, page_count: pages.length, coverage_binding_count: bindingHashes.length, coverage_binding_sha256: digest(bindingHashes), shard_count: shards.length, public_key_sha256, manifest: manifestPin, pointer: pointerPin }),
  });
}
