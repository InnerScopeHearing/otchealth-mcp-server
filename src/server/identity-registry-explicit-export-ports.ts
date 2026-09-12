/**
 * Concrete source-owner ports for the explicit identity exporter. These ports
 * use the ECS task role and KMS, never a private key or AWS credential value.
 * Construction is inert. A caller must explicitly invoke the exporter before
 * KMS or S3 is contacted.
 */
import { createPublicKey, verify } from 'node:crypto';
import { createIdentityRegistryS3Runtime, type IdentityRegistryS3Runtime, type RuntimeIdentityRegistryS3StoreConfig } from './identity-registry-s3-runtime.js';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../search/sigv4.js';

const VERSION = /^[A-Za-z0-9._~+/-]{1,1024}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,1023}$/;
const KMS_KEY = /^(?:alias\/[A-Za-z0-9/_-]{1,256}|arn:aws(?:-us-gov)?:kms:[a-z]{2}(?:-gov)?-[a-z]+-\d:\d{12}:key\/[a-f0-9-]{36})$/;
const MAX_RESPONSE = 32 * 1024;
const SOURCE_BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const SOURCE_REGION = 'us-east-1';

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function validKey(key: string): boolean { return KEY.test(key) && key.split('/').every(part => part && part !== '.' && part !== '..'); }
function version(headers: Headers): string {
  const value = headers.get('x-amz-version-id');
  if (!value || value === 'null' || !VERSION.test(value)) fail('identity_export_store_invalid');
  return value;
}
function exactEncryption(headers: Headers, sse: RuntimeIdentityRegistryS3StoreConfig['sse']): void {
  if (headers.get('x-amz-server-side-encryption') !== sse.algorithm ||
      (sse.algorithm === 'aws:kms' && headers.get('x-amz-server-side-encryption-aws-kms-key-id') !== sse.kmsKeyId)) fail('identity_export_store_invalid');
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body || response.status !== 200) fail('identity_export_kms_unavailable');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE)) fail('identity_export_kms_unavailable');
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_RESPONSE) { await reader.cancel(); fail('identity_export_kms_unavailable'); } chunks.push(Buffer.from(part.value)); }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail('identity_export_kms_unavailable'); }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('identity_export_kms_unavailable');
  return value as Record<string, unknown>;
}

export type CfoIdentityRegistryKmsSignerConfig = Readonly<{
  region: string;
  keyId: string;
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  signRequest?: typeof signRequest;
  fetch?: typeof globalThis.fetch;
}>;

/** KMS holds the Ed25519 private key. The public SPKI is fetched and normalized once. */
export async function createCfoIdentityRegistryKmsSigner(config: CfoIdentityRegistryKmsSignerConfig): Promise<Readonly<{ publicKey: string; sign(bytes: Buffer): Promise<Buffer> }>> {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.region) || !KMS_KEY.test(config.keyId)) fail('identity_export_kms_configuration');
  const credentials = config.resolveCredentials ?? resolveAwsCredentials, requestSigner = config.signRequest ?? signRequest, fetcher = config.fetch ?? fetch;
  const host = `kms.${config.region}.amazonaws.com`;
  async function call(target: 'TrentService.GetPublicKey' | 'TrentService.Sign', body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const creds = await credentials(); if (!creds) fail('identity_export_kms_credentials_unavailable');
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const signed = requestSigner({ method: 'POST', host, path: '/', region: config.region, service: 'kms', credentials: creds, body: payload,
      extraHeaders: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target } });
    let response: Response;
    try { response = await fetcher(`https://${host}/`, { method: 'POST', headers: signed.headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { fail('identity_export_kms_unavailable'); }
    return boundedJson(response);
  }
  const publicResponse = await call('TrentService.GetPublicKey', { KeyId: config.keyId });
  if (publicResponse.KeySpec !== 'ED25519' || publicResponse.KeyUsage !== 'SIGN_VERIFY' || typeof publicResponse.PublicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicResponse.PublicKey)) fail('identity_export_kms_unavailable');
  let key;
  try { key = createPublicKey({ key: Buffer.from(publicResponse.PublicKey, 'base64'), format: 'der', type: 'spki' }); } catch { fail('identity_export_kms_unavailable'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('identity_export_kms_unavailable');
  const publicKey = key.export({ type: 'spki', format: 'pem' }).toString();
  return Object.freeze({ publicKey, async sign(bytes: Buffer): Promise<Buffer> {
    if (!Buffer.isBuffer(bytes) || bytes.length > 512 * 1024) fail('identity_export_signature_invalid');
    const signed = await call('TrentService.Sign', { KeyId: config.keyId, Message: bytes.toString('base64'), MessageType: 'RAW', SigningAlgorithm: 'EDDSA' });
    if (signed.SigningAlgorithm !== 'EDDSA' || typeof signed.Signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.Signature)) fail('identity_export_signature_invalid');
    const signature = Buffer.from(signed.Signature, 'base64');
    if (signature.length !== 64 || !verify(null, bytes, key, signature)) fail('identity_export_signature_invalid');
    return signature;
  } });
}

export type ExplicitExportImmutableStoreConfig = RuntimeIdentityRegistryS3StoreConfig & Readonly<{
  operationTimeoutMs?: number;
  createRuntime?: (config: RuntimeIdentityRegistryS3StoreConfig) => IdentityRegistryS3Runtime;
}>;

/** Versioned, encrypted, conditional-create source-page writer with exact replay reconciliation. */
export function createExplicitExportImmutableStore(config: ExplicitExportImmutableStoreConfig): Readonly<{ putImmutable(input: { key: string; body: Buffer }): Promise<{ version_id: string }> }> {
  const timeout = config.operationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000 || config.bucket !== SOURCE_BUCKET || config.region !== SOURCE_REGION || !validKey(config.prefix) || !config.prefix.startsWith('graph-trial/')) fail('identity_export_store_configuration');
  const runtime = (config.createRuntime ?? createIdentityRegistryS3Runtime)(config);
  const prefix = config.prefix + '/';
  async function read(key: string, body: Buffer, signal: AbortSignal): Promise<{ version_id: string } | null> {
    const response = await runtime.request({ method: 'GET', key, signal });
    if (response.status === 404) return null;
    if (response.status !== 200) fail('identity_export_store_invalid');
    exactEncryption(response.headers, config.sse);
    const version_id = version(response.headers);
    if (!response.body.equals(body)) fail('identity_export_store_conflict');
    return { version_id };
  }
  return Object.freeze({ async putImmutable({ key, body }) {
    if (!validKey(key) || !key.startsWith(prefix) || !Buffer.isBuffer(body) || body.length < 1 || body.length > 512 * 1024) fail('identity_export_store_invalid');
    const signal = AbortSignal.timeout(timeout);
    await runtime.preflight(signal);
    try {
      const response = await runtime.request({ method: 'PUT', key, body: body.toString('utf8'), headers: { 'content-type': 'application/json', 'if-none-match': '*', 'x-amz-server-side-encryption': config.sse.algorithm, ...(config.sse.algorithm === 'aws:kms' ? { 'x-amz-server-side-encryption-aws-kms-key-id': config.sse.kmsKeyId } : {}) }, signal });
      if (response.status === 200 || response.status === 201) {
        const version_id = version(response.headers);
        const pinned = await runtime.request({ method: 'GET', key, versionId: version_id, signal });
        if (pinned.status !== 200) fail('identity_export_store_invalid');
        exactEncryption(pinned.headers, config.sse);
        if (version(pinned.headers) !== version_id || !pinned.body.equals(body)) fail('identity_export_store_invalid');
        return { version_id };
      }
      if (response.status !== 409 && response.status !== 412) fail('identity_export_store_invalid');
    } catch (error) {
      if (error?.code === 'identity_export_store_conflict' || error?.code === 'identity_export_store_invalid') throw error;
    }
    const existing = await read(key, body, signal);
    if (!existing) fail('identity_export_store_invalid');
    return existing;
  } });
}
