import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';

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
// A human mention is display data, unlike an identifier. Spaces are valid, but
// controls and accidental leading/trailing whitespace are not.
const displayText = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\0\p{C}]/u.test(value);
const validKey = key => typeof key === 'string' && KEY.test(key) && key.split('/').every(part => part && part !== '.' && part !== '..');
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

function validAuthority(value) { return exact(value, ['adapter_id', 'schema', 'scope', 'source_system', 'version']) && value.schema === 'authenticated-structured-identity-authority-v1' && value.scope === 'cfo' && text(value.adapter_id) && text(value.source_system) && text(value.version); }
function validRun(value) {
  if (!exact(value, ['manifest_sha256', 'purpose', 'ref_version', 'run_id', 'run_version', 'scope'])) return false;
  const unsigned = { ref_version: value.ref_version, purpose: value.purpose, scope: value.scope, run_version: value.run_version, manifest_sha256: value.manifest_sha256 };
  return value.ref_version === 'neptune-trial-active-run-ref-v1' && value.scope === 'finance' && text(value.purpose) && text(value.run_version) && HASH.test(value.manifest_sha256) && value.run_id === 'run_' + digest(unsigned);
}
function validEndpoint(value, mention) { return exact(value, ['display_name', 'entity_type', 'identifier']) && value.display_name === mention && displayText(value.display_name) && text(value.entity_type) && value.identifier && typeof value.identifier === 'object' && !Array.isArray(value.identifier) && exact(value.identifier, ['namespace', 'scope', 'value']) && text(value.identifier.namespace) && text(value.identifier.scope) && text(value.identifier.value); }
function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !text(value.source_record_id) || !text(value.source_document_version) || !HASH.test(value.source_sha256) || !displayText(value.mention)) return false;
  if (value.disposition === 'unresolved') return exact(value, ['disposition', 'mention', 'source_document_version', 'source_record_id', 'source_sha256']);
  if (value.disposition === 'revoked') return exact(value, ['disposition', 'mention', 'revocation_id', 'source_document_version', 'source_record_id', 'source_sha256']) && text(value.revocation_id);
  return value.disposition === 'resolved' && exact(value, ['disposition', 'endpoint', 'mention', 'source_document_version', 'source_record_id', 'source_sha256']) && validEndpoint(value.endpoint, value.mention);
}
function bindingHash(binding) {
  if (!exact(binding, ['chunk_sha256', 'source_document_version']) || !text(binding.source_document_version) || !HASH.test(binding.chunk_sha256)) fail('identity_export_binding_invalid');
  return digest({ source_document_version: binding.source_document_version, source_sha256: binding.chunk_sha256 });
}
function normalizedPublicKey(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096 || !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(value)) fail('identity_export_signer_invalid');
  try { createPrivateKey(value); fail('identity_export_signer_invalid'); } catch (error) { if (error?.code === 'identity_export_signer_invalid') throw error; }
  let key;
  try { key = createPublicKey(value); } catch { fail('identity_export_signer_invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('identity_export_signer_invalid');
  return Object.freeze({ key, pem: key.export({ type: 'spki', format: 'pem' }).toString() });
}
async function signed(snapshot, signer, publicKey) {
  const bytes = Buffer.from(canonicalJson(snapshot), 'utf8');
  if (bytes.length > signer.maxMessageBytes) fail('identity_export_signature_too_large');
  let signature;
  try { signature = await signer.sign(bytes); } catch { fail('identity_export_signature_invalid'); }
  if (!Buffer.isBuffer(signature) || signature.length !== 64 || !verify(null, bytes, publicKey, signature)) fail('identity_export_signature_invalid');
  return { snapshot, signature: signature.toString('base64') };
}
function validShard(value) { return exact(value, ['registry_version', 'shard_id']) && LABEL.test(value.shard_id) && text(value.registry_version); }
function signable(snapshot, signer) { if (Buffer.byteLength(canonicalJson(snapshot), 'utf8') > signer.maxMessageBytes) fail('identity_export_signature_too_large'); }

/**
 * Publishes an explicit-ID source export through injected CFO-owned ports.
 * `signer` exposes only a public key and sign(bytes); private material remains
 * in the caller's approved secrets store. `store` must be immutable and return
 * the assigned object version after each write.
 */
export async function publishExplicitIdentityRegistryExport({ input, signer, store }) {
  if (!input || !exact(input, ['authority', 'bindings', 'catalog', 'expires_at', 'partition_manifest_version', 'prefix', 'records', 'registry_id', 'run', 'shards', 'source_generation', 'source_version'])) fail('identity_export_input_invalid');
  if (!LABEL.test(input.registry_id) || !validAuthority(input.authority) || !validRun(input.run) || !exact(input.catalog, ['catalog_sha256', 'catalog_version']) || !text(input.catalog.catalog_version) || !HASH.test(input.catalog.catalog_sha256) || !/^sirm_[a-f0-9]{64}$/.test(input.partition_manifest_version) || !text(input.source_generation) || !text(input.source_version) || !validKey(input.prefix) || !input.prefix.startsWith('graph-trial/') || !Array.isArray(input.records) || !Array.isArray(input.bindings) || !Array.isArray(input.shards) || input.records.length > 100 || input.bindings.length > 100 || input.shards.length !== 1 || !Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.now() + 1000) fail('identity_export_input_invalid');
  if (!signer || typeof signer.sign !== 'function' || typeof signer.publicKey !== 'string' || !Number.isSafeInteger(signer.maxMessageBytes) || signer.maxMessageBytes < 128 || signer.maxMessageBytes > 512 * 1024) fail('identity_export_signer_invalid');
  const publicKey = normalizedPublicKey(signer.publicKey);
  if (!store || typeof store.putImmutable !== 'function' || !Number.isSafeInteger(store.maxVersionIdBytes) || store.maxVersionIdBytes < 1 || store.maxVersionIdBytes > 1024) fail('identity_export_store_invalid');
  if (!input.records.every(validRecord)) fail('identity_export_record_not_explicit');
  if (new Set(input.records.map(record => record.source_record_id)).size !== input.records.length) fail('identity_export_record_duplicate');
  const bindingHashes = input.bindings.map(bindingHash).sort();
  if (new Set(bindingHashes).size !== bindingHashes.length) fail('identity_export_binding_duplicate');
  const knownBindings = new Set(bindingHashes);
  if (input.records.some(record => !knownBindings.has(digest({ source_document_version: record.source_document_version, source_sha256: record.source_sha256 })))) fail('identity_export_record_binding_missing');
  if (!input.shards.every(validShard) || new Set(input.shards.map(shard => shard.shard_id)).size !== input.shards.length) fail('identity_export_shard_invalid');
  const prefix = input.prefix, pageRows = chunks(input.records, 100), coverageRows = chunks(bindingHashes, 100);
  if (!pageRows.length || !coverageRows.length) fail('identity_export_input_empty');
  const public_key_sha256 = digest(publicKey.key.export({ type: 'spki', format: 'der' }));
  const predictedVersion = 'v'.repeat(store.maxVersionIdBytes);
  const pagesPreview = pageRows.map((_, index) => ({ cursor: index === 0 ? null : `page-${index}`, key: `${prefix}/pages/${index}.json`, version_id: predictedVersion, sha256: '0'.repeat(64), source_version: input.source_version }));
  const coveragePreview = coverageRows.map((_, index) => ({ cursor: index === 0 ? null : `coverage-${index}`, key: `${prefix}/coverage/${index}.json`, version_id: predictedVersion, sha256: '0'.repeat(64), source_version: input.source_version }));
  const shardsPreview = input.shards.map(item => ({ shard_id: item.shard_id, key: `${prefix}/shards/${item.shard_id}.json`, version_id: predictedVersion, sha256: '0'.repeat(64), registry_version: item.registry_version, source_version: input.source_version }));
  const unsignedPreview = { registry_id: input.registry_id, source_authority: input.authority, run: input.run, catalog: input.catalog, partition_manifest_version: input.partition_manifest_version, source_generation: input.source_generation, pages: pagesPreview, coverage_pages: coveragePreview, shards: shardsPreview, coverage_binding_count: bindingHashes.length, coverage_binding_sha256: digest(bindingHashes), public_key_sha256 };
  signable({ schema: 'source-identity-registry-explicit-export-manifest-v1', ...unsignedPreview, version: 'siex_' + digest(unsignedPreview) }, signer);
  signable({ schema: 'source-identity-registry-explicit-export-current-v1', registry_id: input.registry_id, manifest_version: 'siex_' + '0'.repeat(64), source_generation: input.source_generation, expires_at: input.expires_at, revoked: false }, signer);
  // Prove the configured signing authority returns a valid Ed25519 signature
  // before the first immutable write. This preflight envelope is never stored.
  await signed({ schema: 'source-identity-registry-explicit-export-signer-preflight-v1' }, signer, publicKey.key);
  const put = async (keyName, value) => {
    if (!validKey(keyName) || !keyName.startsWith(prefix + '/')) fail('identity_export_key_invalid');
    const body = Buffer.from(canonicalJson(value), 'utf8');
    const written = await store.putImmutable({ key: keyName, body });
    if (!written || !VERSION.test(written.version_id) || written.version_id === 'null' || written.version_id.length > store.maxVersionIdBytes) fail('identity_export_store_invalid');
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
    const current = { schema: 'source-identity-registry-explicit-export-shard-current-v1', registry_id: input.registry_id, partition_manifest_version: input.partition_manifest_version, shard_id: item.shard_id, registry_version: item.registry_version, source_version: input.source_version, source_generation: input.source_generation, current: true };
    const pin = await put(`${prefix}/shards/${item.shard_id}.json`, current);
    shards.push({ shard_id: item.shard_id, ...pin, registry_version: item.registry_version, source_version: input.source_version });
  }
  const unsigned = { registry_id: input.registry_id, source_authority: input.authority, run: input.run, catalog: input.catalog, partition_manifest_version: input.partition_manifest_version, source_generation: input.source_generation, pages, coverage_pages, shards, coverage_binding_count: bindingHashes.length, coverage_binding_sha256: digest(bindingHashes), public_key_sha256 };
  const manifest = await signed({ schema: 'source-identity-registry-explicit-export-manifest-v1', ...unsigned, version: 'siex_' + digest(unsigned) }, signer, publicKey.key);
  const manifestPin = await put(`${prefix}/exports/manifest.json`, manifest);
  const pointer = await signed({ schema: 'source-identity-registry-explicit-export-current-v1', registry_id: input.registry_id, manifest_version: manifest.snapshot.version, source_generation: input.source_generation, expires_at: input.expires_at, revoked: false }, signer, publicKey.key);
  const pointerPin = await put(`${prefix}/exports/current.json`, pointer);
  return Object.freeze({
    public_config: Object.freeze({ registry_id: input.registry_id, authority: input.authority, binding: { authenticated_caller: 'cfo', room: 'finance', source_index: 'finance-cfo-source-docs', run: input.run }, public_key: publicKey.pem, partition_manifest_version: input.partition_manifest_version, source: { prefix, manifest: manifestPin, pointer: { key: pointerPin.key }, catalog: input.catalog } }),
    receipt: Object.freeze({ schema: 'source-identity-registry-explicit-export-receipt-v1', registry_id: input.registry_id, manifest_version: manifest.snapshot.version, source_generation: input.source_generation, page_count: pages.length, coverage_binding_count: bindingHashes.length, coverage_binding_sha256: digest(bindingHashes), shard_count: shards.length, public_key_sha256, manifest: manifestPin, pointer: pointerPin }),
  });
}
