import { createHash } from 'node:crypto';
import { canonicalUri, resolveAwsCredentials, signRequest, type AwsCredentials, type SignedRequest } from '../../search/sigv4.js';
import type { BrowserFileRecord, BrowserFileStore } from './file-broker.js';

export const BROWSER_FILE_STORE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TABLE = 'otchealth-browser-cloud';
const DEFAULT_BUCKET = 'otchealth-chat-agents-900915535335-us-east-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const TYPES = new Set(['text/csv', 'text/plain', 'application/pdf', 'image/png', 'image/jpeg']);
type Fetch = typeof globalThis.fetch;
type Signer = (input: Parameters<typeof signRequest>[0]) => SignedRequest;
type Attribute = { S?: string; N?: string };
type Item = Record<string, Attribute>;

export interface AwsBrowserFileStoreConfig { region?: string; table?: string; bucket?: string; }
export interface AwsBrowserFileStoreDeps {
  credentials?: () => Promise<AwsCredentials | null>;
  sign?: Signer;
  fetch?: Fetch;
  now?: () => number;
}

function checkedConfig(input: AwsBrowserFileStoreConfig) {
  const config = { region: input.region ?? DEFAULT_REGION, table: input.table ?? DEFAULT_TABLE, bucket: input.bucket ?? DEFAULT_BUCKET };
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(config.region) || !/^[a-z0-9_-]{3,255}$/.test(config.table) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new Error('browser_file_store_config_invalid');
  return config;
}

function parseKey(key: string): { owner: string; id: string } {
  const match = /^browser-files\/([a-z0-9][a-z0-9_-]{1,63})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key);
  if (!match || !OWNER.test(match[1]!) || !UUID.test(match[2]!)) throw new Error('browser_file_store_key_invalid');
  return { owner: match[1]!, id: match[2]! };
}

function objectKey(owner: string, id: string): string { return `browser-cloud/files/${owner}/${id}`; }
function validRecord(value: unknown, owner: string, id: string): value is BrowserFileRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<BrowserFileRecord>;
  return record.id === id && record.owner === owner && typeof record.filename === 'string' && record.filename.length > 0 && record.filename.length <= 128
    && (record.ownerSubjectHash === undefined || (typeof record.ownerSubjectHash === 'string' && /^[a-f0-9]{64}$/.test(record.ownerSubjectHash)))
    && typeof record.contentType === 'string' && TYPES.has(record.contentType)
    && Number.isSafeInteger(record.byteLength) && record.byteLength! >= 1 && record.byteLength! <= BROWSER_FILE_STORE_MAX_BYTES
    && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256)
    && (record.status === 'quarantined' || record.status === 'ready' || record.status === 'partial')
    && Number.isSafeInteger(record.expiresAt) && record.expiresAt! >= 0;
}

function readRecord(item: Item | undefined, owner: string, id: string): { record: BrowserFileRecord; storageKey: string; storageVersion: string; expiresAtEpoch: number } | null {
  if (!item || item.pk?.S !== `FILE#${owner}#${id}`) return null;
  const record = {
    id: item.fileId?.S,
    owner: item.owner?.S,
    ...(Object.hasOwn(item, 'ownerSubjectHash') ? { ownerSubjectHash: item.ownerSubjectHash?.S ?? null } : {}),
    filename: item.filename?.S,
    contentType: item.contentType?.S,
    byteLength: Number(item.byteLength?.N),
    sha256: item.sha256?.S,
    status: item.status?.S,
    expiresAt: Number(item.expiresAt?.N),
  };
  const storageKey = item.storageKey?.S;
  const storageVersion = item.storageVersion?.S;
  const expiresAtEpoch = Number(item.expiresAtEpoch?.N);
  if (!validRecord(record, owner, id) || storageKey !== objectKey(owner, id) || !storageVersion || storageVersion === 'null' || !Number.isSafeInteger(expiresAtEpoch)) return null;
  return { record, storageKey, storageVersion, expiresAtEpoch };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('browser_file_store_body_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

/** AWS-backed immutable file bytes plus owner-scoped metadata in the browser-cloud table. */
export function createAwsBrowserFileStore(configInput: AwsBrowserFileStoreConfig = {}, deps: AwsBrowserFileStoreDeps = {}): BrowserFileStore {
  const config = checkedConfig(configInput);
  const credentials = deps.credentials ?? resolveAwsCredentials;
  const signer = deps.sign ?? signRequest;
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  const dynamo = async (target: 'PutItem' | 'GetItem', payload: unknown): Promise<Record<string, unknown>> => {
    const creds = await credentials();
    if (!creds) throw new Error('browser_file_store_credentials_unavailable');
    const host = `dynamodb.${config.region}.amazonaws.com`;
    const body = JSON.stringify(payload);
    const signed = signer({ method: 'POST', host, path: '/', region: config.region, service: 'dynamodb', credentials: creds, body, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` } });
    const response = await fetcher(`https://${host}/`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('browser_file_store_metadata_failed');
    const text = await response.text();
    if (text.length > 128 * 1024) throw new Error('browser_file_store_metadata_invalid');
    try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('browser_file_store_metadata_invalid'); }
  };

  const s3 = async (method: 'PUT' | 'GET', key: string, body?: Uint8Array, version?: string, contentType?: string): Promise<Response> => {
    const creds = await credentials();
    if (!creds) throw new Error('browser_file_store_credentials_unavailable');
    const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
    const path = `/${key}`;
    const hash = createHash('sha256').update(body ?? new Uint8Array()).digest('hex');
    const headers: Record<string, string> = method === 'PUT'
      ? { 'content-type': contentType!, 'if-none-match': '*', 'x-amz-server-side-encryption': 'AES256', 'x-amz-meta-sha256': hash, 'x-amz-content-sha256': hash }
      : { 'x-amz-content-sha256': hash };
    const signed = signer({ method, host, path, ...(version ? { query: { versionId: version } } : {}), region: config.region, service: 's3', credentials: creds, ...(body ? { body: Buffer.from(body) } : {}), extraHeaders: headers });
    const url = `https://${host}${canonicalUri(path)}${version ? `?versionId=${encodeURIComponent(version)}` : ''}`;
    return fetcher(url, { method, headers: signed.headers, ...(body ? { body: Buffer.from(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  };

  return {
    async put(key, record, body) {
      const { owner, id } = parseKey(key);
      if (!validRecord(record, owner, id) || !(body instanceof Uint8Array) || body.byteLength !== record.byteLength || body.byteLength > BROWSER_FILE_STORE_MAX_BYTES || createHash('sha256').update(body).digest('hex') !== record.sha256) throw new Error('browser_file_store_record_invalid');
      const s3Key = objectKey(owner, id);
      const response = await s3('PUT', s3Key, body, undefined, record.contentType);
      if (!response.ok) throw new Error('browser_file_store_upload_failed');
      const version = response.headers.get('x-amz-version-id');
      if (!version || version === 'null') throw new Error('browser_file_store_version_required');
      await dynamo('PutItem', { TableName: config.table, Item: {
        pk: { S: `FILE#${owner}#${id}` }, fileId: { S: id }, owner: { S: owner }, filename: { S: record.filename },
        ...(record.ownerSubjectHash === undefined ? {} : { ownerSubjectHash: { S: record.ownerSubjectHash } }),
        contentType: { S: record.contentType }, byteLength: { N: String(record.byteLength) }, sha256: { S: record.sha256 },
        status: { S: record.status }, expiresAt: { N: String(record.expiresAt) }, storageKey: { S: s3Key }, storageVersion: { S: version },
        expiresAtEpoch: { N: String(Math.ceil(record.expiresAt / 1_000)) },
      }, ConditionExpression: 'attribute_not_exists(pk)' });
    },

    async get(key) {
      const { owner, id } = parseKey(key);
      const result = await dynamo('GetItem', { TableName: config.table, Key: { pk: { S: `FILE#${owner}#${id}` } }, ConsistentRead: true });
      const item = (result as { Item?: Item }).Item;
      const stored = readRecord(item, owner, id);
      const clock = now();
      if (!stored || !Number.isSafeInteger(clock) || stored.record.expiresAt <= clock || stored.expiresAtEpoch <= Math.floor(clock / 1_000)) return null;
      const response = await s3('GET', stored.storageKey, undefined, stored.storageVersion);
      const declaredRaw = response.headers.get('content-length');
      const declared = declaredRaw === null ? NaN : Number(declaredRaw);
      if (!response.ok || response.headers.get('x-amz-version-id') !== stored.storageVersion || response.headers.get('content-type')?.split(';')[0]?.trim() !== stored.record.contentType || declared !== stored.record.byteLength || declared > BROWSER_FILE_STORE_MAX_BYTES) throw new Error('browser_file_store_integrity_failed');
      let bytes: Uint8Array;
      try { bytes = await readBounded(response, BROWSER_FILE_STORE_MAX_BYTES); } catch { throw new Error('browser_file_store_integrity_failed'); }
      if (bytes.byteLength !== stored.record.byteLength || createHash('sha256').update(bytes).digest('hex') !== stored.record.sha256) throw new Error('browser_file_store_integrity_failed');
      return { record: stored.record, body: bytes };
    },
  };
}
