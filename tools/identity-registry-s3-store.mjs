/**
 * S3 adapter for the signed source-identity registry. It uses only injected
 * SigV4 and HTTP functions. Deployment must provide a versioned bucket, an
 * immutable prefix policy, and an S3-compatible conditional-create route.
 */
import { createHash } from 'node:crypto';

const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$/;
const S3_VERSION = /^[^\s]{1,1024}$/;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = MAX_ENVELOPE_BYTES * 3 + 16 * 1024;
const MAX_DEPTH = 64;
const STORE_SCHEMA = 'identity-registry-s3-store-v1';
const RECEIPT_SCHEMA = 'identity-registry-s3-receipt-v1';

function fail(code, status) { throw Object.assign(new Error(code), { code, status }); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function exact(value, keys) { return !!value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }
function canonical(value) {
  const seen = new Set();
  const visit = (item, depth) => {
    if (depth > MAX_DEPTH) fail('identity_registry_store_json_too_deep');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('identity_registry_store_non_json_value'); return JSON.stringify(item); }
    if ((!Array.isArray(item) && (!item || Object.getPrototypeOf(item) !== Object.prototype)) || typeof item !== 'object') fail('identity_registry_store_non_json_value');
    if (seen.has(item)) fail('identity_registry_store_json_cycle');
    seen.add(item);
    try { return Array.isArray(item) ? '[' + item.map(x => visit(x, depth + 1)).join(',') + ']' : '{' + Object.keys(item).sort().map(k => JSON.stringify(k) + ':' + visit(item[k], depth + 1)).join(',') + '}'; }
    finally { seen.delete(item); }
  };
  return visit(value, 0);
}
function check(signal) { if (signal?.aborted) fail('identity_registry_store_aborted'); }
function validateId(registryId, version) { if (!LABEL.test(registryId || '')) fail('identity_registry_id_invalid'); if (!VERSION.test(version || '')) fail('identity_registry_version_invalid'); }
function cloneJson(value) { let copy; try { copy = structuredClone(value); canonical(copy); } catch (error) { if (error?.code) throw error; fail('identity_registry_store_non_json_value'); } return copy; }
function normalizeConfig(config) {
  if (!exact(config, ['bucket', 'fetchImpl', 'immutableTombstonePolicyAttested', 'prefix', 'region', 'requestTimeoutMs', 'signRequest', 'sse']) || typeof config.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      typeof config.prefix !== 'string' || !/^[a-z0-9][a-z0-9/_-]{0,511}$/.test(config.prefix) || config.prefix.endsWith('/') ||
      typeof config.region !== 'string' || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.region) ||
      typeof config.signRequest !== 'function' || typeof config.fetchImpl !== 'function' ||
      !Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > 120000 ||
      config.immutableTombstonePolicyAttested !== true ||
      !config.sse || !exact(config.sse, config.sse.algorithm === 'AES256' ? ['algorithm'] : ['algorithm', 'kmsKeyId']) ||
      !['AES256', 'aws:kms'].includes(config.sse.algorithm) ||
      (config.sse.algorithm === 'aws:kms' && (typeof config.sse.kmsKeyId !== 'string' || !config.sse.kmsKeyId || config.sse.kmsKeyId.length > 1024))) fail('identity_registry_s3_store_configuration');
  return Object.freeze({ bucket: config.bucket, prefix: config.prefix, region: config.region, requestTimeoutMs: config.requestTimeoutMs, immutableTombstonePolicyAttested: true, signRequest: config.signRequest, fetchImpl: config.fetchImpl,
    sse: Object.freeze(config.sse.algorithm === 'AES256' ? { algorithm: 'AES256' } : { algorithm: 'aws:kms', kmsKeyId: config.sse.kmsKeyId }) });
}
function objectKey(fixed, registryId, kind, version) { return `${fixed.prefix}/identity-registries/${registryId}/${kind}/${version}.json`; }
function urlFor(fixed, key, versionId = null) { const url = `https://${fixed.bucket}.s3.${fixed.region}.amazonaws.com/${key}`; return versionId ? `${url}?versionId=${encodeURIComponent(versionId)}` : url; }
function responseVersion(response) { const value = response.headers?.get?.('x-amz-version-id'); return S3_VERSION.test(value || '') && value !== 'null' ? value : null; }
function verifySignedRoute(actualText, expectedText, expectedHeaders) {
  let actual, expected; try { actual = new URL(actualText); expected = new URL(expectedText); } catch { fail('identity_registry_store_signed_route_invalid'); }
  if (actual.protocol !== 'https:' || actual.hostname !== expected.hostname || actual.port || actual.username || actual.password || actual.hash || actual.pathname !== expected.pathname) fail('identity_registry_store_signed_route_invalid');
  const wantedVersion = expected.searchParams.get('versionId'); const actualVersions = actual.searchParams.getAll('versionId');
  if ((wantedVersion && (actualVersions.length !== 1 || actualVersions[0] !== wantedVersion)) || (!wantedVersion && actualVersions.length)) fail('identity_registry_store_signed_route_invalid');
  if ([...actual.searchParams.keys()].some(name => name !== 'versionId' && !name.startsWith('X-Amz-'))) fail('identity_registry_store_signed_route_invalid');
  const signedHeaders = new Headers(expectedHeaders.signed);
  for (const [name, value] of Object.entries(expectedHeaders.required)) if (signedHeaders.get(name) !== value) fail('identity_registry_store_signed_headers_invalid');
}
async function deadline(work, signal, timeoutMs, onTimeout = () => {}) {
  check(signal); const controller = new AbortController();
  const relay = () => controller.abort(); signal?.addEventListener('abort', relay, { once: true });
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); try { onTimeout(); } catch {} reject(Object.assign(new Error('identity_registry_store_deadline'), { code: 'identity_registry_store_deadline' })); }, timeoutMs); });
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('identity_registry_store_deadline'), { code: 'identity_registry_store_deadline' })), { once: true }));
  try { return await Promise.race([Promise.resolve(work(controller.signal)), expired, aborted]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', relay); }
}
async function responseText(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail('identity_registry_store_response_too_large', response.status);
  if (!response.body?.getReader) fail('identity_registry_store_response_stream_required', response.status);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) { check(signal); const part = await reader.read(); check(signal); if (part.done) break; length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('identity_registry_store_response_too_large', response.status); } chunks.push(Buffer.from(part.value)); }
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
  return Buffer.concat(chunks, length).toString('utf8');
}

export function createIdentityRegistryS3SnapshotStore(config) {
  const fixed = normalizeConfig(config);
  async function request({ method, key, versionId = null, headers = {}, body = '', signal }) {
    check(signal);
    let signed;
    const expectedUrl = urlFor(fixed, key, versionId);
    try { signed = await deadline(activeSignal => fixed.signRequest({ method, url: expectedUrl, service: 's3', region: fixed.region, headers, body, signal: activeSignal }), signal, fixed.requestTimeoutMs); }
    catch (error) { if (error?.code === 'identity_registry_store_deadline') throw error; fail('identity_registry_store_signing_failed'); }
    if (!signed || typeof signed.url !== 'string' || !signed.headers) fail('identity_registry_store_signing_failed');
    verifySignedRoute(signed.url, expectedUrl, { signed: signed.headers, required: headers });
    let response;
    try { response = await deadline(activeSignal => fixed.fetchImpl(signed.url, { method, headers: signed.headers, body: method === 'GET' ? undefined : body, signal: activeSignal, redirect: 'error' }), signal, fixed.requestTimeoutMs); }
    catch (error) { if (error?.code === 'identity_registry_store_deadline') throw error; fail('identity_registry_store_transport_unknown'); }
    check(signal);
    try { return { status: response.status, headers: response.headers, text: await deadline(activeSignal => responseText(response, activeSignal), signal, fixed.requestTimeoutMs, () => response.body?.cancel?.()) }; }
    catch (error) { if (error?.code) throw error; fail('identity_registry_store_transport_unknown'); }
  }
  function validateReadHeaders(response, expectedVersion = null) {
    const actual = responseVersion(response);
    if (!actual || expectedVersion && actual !== expectedVersion || response.headers?.get?.('x-amz-server-side-encryption') !== fixed.sse.algorithm ||
        fixed.sse.kmsKeyId && response.headers?.get?.('x-amz-server-side-encryption-aws-kms-key-id') !== fixed.sse.kmsKeyId) fail('identity_registry_store_read_headers_invalid');
    return actual;
  }
  function record(registryId, version, kind, payload) {
    const payloadText = canonical(payload);
    if (Buffer.byteLength(payloadText) > MAX_ENVELOPE_BYTES) fail('identity_registry_envelope_too_large');
    return Object.freeze({ schema: STORE_SCHEMA, kind, registry_id: registryId, version, payload_sha256: hash(payloadText), payload });
  }
  function parseRecord(text, registryId, version, kind) {
    let value; try { value = JSON.parse(text); } catch { fail('identity_registry_store_corrupt'); }
    if (!exact(value, ['kind', 'payload', 'payload_sha256', 'registry_id', 'schema', 'version']) || value.schema !== STORE_SCHEMA || value.kind !== kind ||
        value.registry_id !== registryId || value.version !== version || !/^[a-f0-9]{64}$/.test(value.payload_sha256 || '')) fail('identity_registry_store_corrupt');
    let payload; try { payload = cloneJson(value.payload); } catch { fail('identity_registry_store_corrupt'); }
    if (hash(canonical(payload)) !== value.payload_sha256 || canonical(value) !== text) fail('identity_registry_store_integrity_failed');
    return Object.freeze({ ...value, payload });
  }
  function receipt(registryId, version, kind, key, objectVersionId, payloadSha) { return Object.freeze({ schema: RECEIPT_SCHEMA, kind, registry_id: registryId, version, object_key: key, object_version_id: objectVersionId, payload_sha256: payloadSha }); }
  function parseReceipt(text, registryId, version, kind, key) {
    let value; try { value = JSON.parse(text); } catch { fail('identity_registry_store_receipt_corrupt'); }
    if (!exact(value, ['kind', 'object_key', 'object_version_id', 'payload_sha256', 'registry_id', 'schema', 'version']) || value.schema !== RECEIPT_SCHEMA || value.kind !== kind ||
        value.registry_id !== registryId || value.version !== version || value.object_key !== key || !S3_VERSION.test(value.object_version_id || '') || value.object_version_id === 'null' || !/^[a-f0-9]{64}$/.test(value.payload_sha256 || '') || canonical(value) !== text) fail('identity_registry_store_receipt_corrupt');
    return Object.freeze(value);
  }
  async function getCurrent(registryId, version, kind, signal) {
    const key = objectKey(fixed, registryId, kind, version);
    const response = await request({ method: 'GET', key, signal });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) fail('identity_registry_store_auth_failed', response.status);
    if (response.status !== 200) fail('identity_registry_store_read_unknown', response.status);
    const id = validateReadHeaders(response);
    return Object.freeze({ key, object_version_id: id, record: parseRecord(response.text, registryId, version, kind) });
  }
  async function getReceipt(registryId, version, kind, signal) {
    const key = objectKey(fixed, registryId, `${kind}-receipts`, version);
    const response = await request({ method: 'GET', key, signal });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) fail('identity_registry_store_auth_failed', response.status);
    if (response.status !== 200) fail('identity_registry_store_read_unknown', response.status);
    validateReadHeaders(response);
    return parseReceipt(response.text, registryId, version, kind, objectKey(fixed, registryId, kind, version));
  }
  async function putImmutable(key, value, signal) {
    const headers = { 'content-type': 'application/json', 'if-none-match': '*', 'x-amz-server-side-encryption': fixed.sse.algorithm };
    if (fixed.sse.kmsKeyId) headers['x-amz-server-side-encryption-aws-kms-key-id'] = fixed.sse.kmsKeyId;
    return request({ method: 'PUT', key, headers, body: canonical(value), signal });
  }
  async function persistReceipt(current, signal) {
    const value = receipt(current.record.registry_id, current.record.version, current.record.kind, current.key, current.object_version_id, current.record.payload_sha256);
    const receiptKey = objectKey(fixed, current.record.registry_id, `${current.record.kind}-receipts`, current.record.version);
    let response;
    try { response = await putImmutable(receiptKey, value, signal); }
    catch (error) { if (error?.code === 'identity_registry_store_transport_unknown') response = null; else throw error; }
    if (response && ![200, 201, 409, 412].includes(response.status)) {
      if (response.status === 401 || response.status === 403) fail('identity_registry_store_auth_failed', response.status);
      fail('identity_registry_store_write_unknown', response.status);
    }
    const durable = await getReceipt(current.record.registry_id, current.record.version, current.record.kind, signal).catch(() => null);
    if (!durable || canonical(durable) !== canonical(value)) fail('identity_registry_store_write_unknown');
    const pinned = await request({ method: 'GET', key: current.key, versionId: durable.object_version_id, signal });
    if (pinned.status !== 200 || validateReadHeaders(pinned, durable.object_version_id) !== durable.object_version_id ||
        parseRecord(pinned.text, current.record.registry_id, current.record.version, current.record.kind).payload_sha256 !== durable.payload_sha256) fail('identity_registry_store_write_unknown');
    return durable;
  }
  async function readPinnedReceipt(receiptValue, registryId, version, kind, signal) {
    const response = await request({ method: 'GET', key: receiptValue.object_key, versionId: receiptValue.object_version_id, signal });
    if (response.status === 404) fail('identity_registry_store_snapshot_missing');
    if (response.status !== 200 || validateReadHeaders(response, receiptValue.object_version_id) !== receiptValue.object_version_id) fail('identity_registry_store_read_unknown', response.status);
    const stored = parseRecord(response.text, registryId, version, kind);
    if (stored.payload_sha256 !== receiptValue.payload_sha256) fail('identity_registry_store_integrity_failed');
    return stored;
  }
  async function revokePresent(registryId, version, signal, { reconcile = false } = {}) {
    const pinnedReceipt = await getReceipt(registryId, version, 'revocations', signal);
    if (pinnedReceipt) { await readPinnedReceipt(pinnedReceipt, registryId, version, 'revocations', signal); return true; }
    const tombstone = await getCurrent(registryId, version, 'revocations', signal);
    if (!tombstone) return false;
    if (reconcile) await persistReceipt(tombstone, signal);
    return true;
  }
  async function reconcileSnapshot(registryId, version, envelope, signal) {
    const current = await getCurrent(registryId, version, 'snapshots', signal);
    if (!current) return null;
    if (current.record.payload_sha256 !== hash(canonical(envelope))) return false;
    await persistReceipt(current, signal);
    return current;
  }
  async function publish({ registry_id: registryId, version, envelope }, { signal } = {}) {
    validateId(registryId, version); check(signal);
    const copy = cloneJson(envelope); const target = record(registryId, version, 'snapshots', copy);
    if (await revokePresent(registryId, version, signal, { reconcile: true })) return false;
    let response;
    try { response = await putImmutable(objectKey(fixed, registryId, 'snapshots', version), target, signal); }
    catch (error) {
      if (error?.code !== 'identity_registry_store_transport_unknown') throw error;
      const recovered = await reconcileSnapshot(registryId, version, copy, signal); if (!recovered) fail('identity_registry_store_write_unknown');
      return !(await revokePresent(registryId, version, signal, { reconcile: true }));
    }
    if (response.status === 401 || response.status === 403) fail('identity_registry_store_auth_failed', response.status);
    if (response.status === 409 || response.status === 412) {
      const found = await reconcileSnapshot(registryId, version, copy, signal);
      if (found === null) fail('identity_registry_store_write_unknown');
      return false;
    }
    if (![200, 201].includes(response.status)) { const found = await reconcileSnapshot(registryId, version, copy, signal); if (!found) fail('identity_registry_store_write_unknown', response.status); return !(await revokePresent(registryId, version, signal, { reconcile: true })); }
    const created = await reconcileSnapshot(registryId, version, copy, signal); if (!created) fail('identity_registry_store_write_unknown');
    return !(await revokePresent(registryId, version, signal, { reconcile: true }));
  }
  async function read({ registry_id: registryId, version }, { signal } = {}) {
    validateId(registryId, version); check(signal);
    if (await revokePresent(registryId, version, signal)) return { status: 'revoked' };
    const receiptValue = await getReceipt(registryId, version, 'snapshots', signal);
    if (!receiptValue) { const orphan = await getCurrent(registryId, version, 'snapshots', signal); if (!orphan) return { status: 'missing' }; fail('identity_registry_store_snapshot_unreconciled'); }
    const stored = await readPinnedReceipt(receiptValue, registryId, version, 'snapshots', signal);
    if (await revokePresent(registryId, version, signal)) return { status: 'revoked' };
    return { status: 'active', envelope: cloneJson(stored.payload) };
  }
  async function revoke({ registry_id: registryId, version, reason = 'deployment_revocation' }, { signal } = {}) {
    validateId(registryId, version); if (typeof reason !== 'string' || !reason || reason.length > 240) fail('identity_registry_revocation_reason_invalid');
    const target = record(registryId, version, 'revocations', { reason });
    let response;
    try { response = await putImmutable(objectKey(fixed, registryId, 'revocations', version), target, signal); }
    catch (error) { if (error?.code !== 'identity_registry_store_transport_unknown') throw error; response = null; }
    if (response && response.status !== 200 && response.status !== 201 && response.status !== 409 && response.status !== 412) fail('identity_registry_store_write_unknown', response.status);
    const tombstone = await getCurrent(registryId, version, 'revocations', signal); if (!tombstone) fail('identity_registry_store_write_unknown');
    await persistReceipt(tombstone, signal);
    return response?.status === 200 || response?.status === 201;
  }
  return Object.freeze({ publish, read, revoke, reconcile: async ({ registry_id, version, envelope }, { signal } = {}) => {
    validateId(registry_id, version); if (await revokePresent(registry_id, version, signal, { reconcile: true })) return { status: 'revoked' };
    const recovered = await reconcileSnapshot(registry_id, version, cloneJson(envelope), signal); return recovered === false ? { status: 'conflict' } : recovered ? { status: 'active' } : { status: 'missing' };
  } });
}
