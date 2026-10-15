import { createHash } from 'node:crypto';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import { DaytonaBrowserError, type DaytonaBinding } from './contract.js';
import { assertDaytonaBinding } from './store.js';

export interface DaytonaViewerGrantRecord {
  version: 2;
  organizationId: string;
  /** Immutable, NONSECRET server-owned enrollment for restart/expiry cleanup. */
  binding: DaytonaBinding;
  grantHandle: string;
  bindingHash: string;
  /** Physical desktop fence, independent of profile or logical mission expiry. */
  scopeHash: string;
  expiresAt: number;
  phase: 'MINTING' | 'ACTIVE' | 'REVOKING' | 'REVOKED';
  sealed?: { iv: string; tag: string; ciphertext: string };
}
export interface DaytonaViewerGrantStore {
  reserve(record: DaytonaViewerGrantRecord, signal: AbortSignal): Promise<boolean>;
  load(grantHandle: string, signal: AbortSignal): Promise<DaytonaViewerGrantRecord | null>;
  /** Trusted server-only exact physical lookup; never a scan or public tool. */
  readPhysicalScope(scopeHash: string, signal: AbortSignal): Promise<string | null>;
  compareAndSwap(before: DaytonaViewerGrantRecord, after: DaytonaViewerGrantRecord, signal: AbortSignal): Promise<boolean>;
}
export interface DynamoDaytonaViewerGrantStoreOptions {
  tableName: string;
  region: string;
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function fail(): never { throw new DaytonaBrowserError('daytona_viewer_store_unavailable'); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function daytonaViewerGrantBindingHash(organizationId: string, binding: DaytonaBinding): string {
  if (!UUID.test(organizationId)) fail(); assertDaytonaBinding(binding);
  const parts = ['daytona-viewer-v1', organizationId, binding.owner, binding.ownerSubjectHash, binding.sandboxId, binding.profileKey, binding.profilePath, binding.readinessReceiptSha256];
  // Append only for explicitly shared enrollment, preserving existing receipts.
  if (binding.sharedProfileKey !== undefined) parts.push(binding.sharedProfileKey);
  return hash(parts);
}
export function daytonaViewerPhysicalScopeHash(organizationId: string, sandboxId: string): string {
  if (!UUID.test(organizationId) || !ID.test(sandboxId)) fail(); return hash(['daytona-viewer-scope-v1', organizationId, sandboxId]);
}
function encoded(value: unknown, bytes?: number): boolean {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const buffer = Buffer.from(value, 'base64url'); return buffer.toString('base64url') === value && (bytes === undefined || buffer.length === bytes);
}
export function assertDaytonaViewerGrantRecord(value: unknown): asserts value is DaytonaViewerGrantRecord {
  if (!object(value) || Object.keys(value).some(key => !['version', 'organizationId', 'binding', 'grantHandle', 'bindingHash', 'scopeHash', 'expiresAt', 'phase', 'sealed'].includes(key))
    || value.version !== 2 || typeof value.organizationId !== 'string' || !UUID.test(value.organizationId)
    || typeof value.grantHandle !== 'string' || !UUID.test(value.grantHandle) || typeof value.bindingHash !== 'string' || !HASH.test(value.bindingHash)
    || typeof value.scopeHash !== 'string' || !HASH.test(value.scopeHash) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0
    || !['MINTING', 'ACTIVE', 'REVOKING', 'REVOKED'].includes(String(value.phase))) fail();
  assertDaytonaBinding(value.binding);
  if (value.bindingHash !== daytonaViewerGrantBindingHash(value.organizationId, value.binding) || value.scopeHash !== daytonaViewerPhysicalScopeHash(value.organizationId, value.binding.sandboxId)) fail();
  if (value.phase === 'ACTIVE' || value.phase === 'REVOKING') {
    if (!object(value.sealed) || Object.keys(value.sealed).length !== 3 || !encoded(value.sealed.iv, 12) || !encoded(value.sealed.tag, 16) || !encoded(value.sealed.ciphertext)) fail();
  } else if (value.sealed !== undefined) fail();
}
type Item = Record<string, { S?: string; N?: string }>;
class Conflict extends Error {}

/** Private ciphertext only. Nonterminal receipts/fences have NO TTL or time takeover. */
export class DynamoDaytonaViewerGrantStore implements DaytonaViewerGrantStore {
  private readonly credentials: () => Promise<AwsCredentials | null>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: DynamoDaytonaViewerGrantStoreOptions) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.tableName) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(options.region)) fail();
    this.credentials = options.resolveCredentials ?? resolveAwsCredentials; this.fetcher = options.fetchImpl ?? fetch; this.now = options.now ?? Date.now;
  }
  private key(kind: 'GRANT' | 'SCOPE', id: string): string {
    if (!(kind === 'GRANT' ? UUID : HASH).test(id)) fail(); return `DAYTONA#VIEWER_${kind}#${id}`;
  }
  private async call(operation: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      signal.throwIfAborted(); const credentials = await this.credentials(); signal.throwIfAborted(); if (!credentials) fail();
      const host = `dynamodb.${this.options.region}.amazonaws.com`; const body = JSON.stringify(payload);
      const signed = signRequest({ method: 'POST', host, path: '/', body, region: this.options.region, service: 'dynamodb', credentials, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` } });
      const response = await this.fetcher(`https://${host}/`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      signal.throwIfAborted(); if (!response.body) fail();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 131072) { await reader.cancel(); fail(); } chunks.push(next.value); }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted(); const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(data)) fail();
      if (!response.ok) {
        const kind = typeof data.__type === 'string' ? data.__type.split('#').at(-1) : '';
        if (kind === 'ConditionalCheckFailedException') throw new Conflict();
        if (kind === 'TransactionCanceledException' && Array.isArray(data.CancellationReasons)) {
          const codes = data.CancellationReasons.map(value => object(value) ? value.Code : undefined);
          if (codes.includes('ConditionalCheckFailed') && codes.every(code => code === 'None' || code === 'ConditionalCheckFailed')) throw new Conflict();
        }
        fail();
      }
      return data;
    } catch (error) { if (error instanceof Conflict) throw error; return fail(); }
  }
  async reserve(value: DaytonaViewerGrantRecord, signal: AbortSignal): Promise<boolean> {
    assertDaytonaViewerGrantRecord(value); if (value.phase !== 'MINTING') fail();
    try {
      await this.call('TransactWriteItems', { TransactItems: [
        { Put: { TableName: this.options.tableName, Item: { pk: { S: this.key('SCOPE', value.scopeHash) }, grantHandle: { S: value.grantHandle } }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: this.options.tableName, Item: { pk: { S: this.key('GRANT', value.grantHandle) }, payload: { S: JSON.stringify(value) } }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }, signal); return true;
    } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async load(handle: string, signal: AbortSignal): Promise<DaytonaViewerGrantRecord | null> {
    const pk = this.key('GRANT', handle); const result = await this.call('GetItem', { TableName: this.options.tableName, Key: { pk: { S: pk } }, ConsistentRead: true }, signal);
    if (result.Item === undefined) return null;
    if (!object(result.Item)) fail(); const item = result.Item as Item;
    if (item.pk?.S !== pk || typeof item.payload?.S !== 'string' || item.payload.S.length > 20000) fail();
    let parsed: unknown; try { parsed = JSON.parse(item.payload.S); } catch { return fail(); }
    assertDaytonaViewerGrantRecord(parsed); if (parsed.grantHandle !== handle) fail(); return parsed;
  }
  async readPhysicalScope(scopeHash: string, signal: AbortSignal): Promise<string | null> {
    const pk = this.key('SCOPE', scopeHash); const result = await this.call('GetItem', { TableName: this.options.tableName, Key: { pk: { S: pk } }, ConsistentRead: true }, signal);
    if (result.Item === undefined) return null;
    if (!object(result.Item)) fail(); const item = result.Item as Item;
    if (item.pk?.S !== pk || typeof item.grantHandle?.S !== 'string' || !UUID.test(item.grantHandle.S) || item.expiresAtEpoch !== undefined) fail();
    return item.grantHandle.S;
  }
  async compareAndSwap(before: DaytonaViewerGrantRecord, after: DaytonaViewerGrantRecord, signal: AbortSignal): Promise<boolean> {
    assertDaytonaViewerGrantRecord(before); assertDaytonaViewerGrantRecord(after);
    if (before.grantHandle !== after.grantHandle || before.organizationId !== after.organizationId || before.bindingHash !== after.bindingHash || before.scopeHash !== after.scopeHash || before.expiresAt !== after.expiresAt
      || !({ MINTING: ['ACTIVE'], ACTIVE: ['REVOKING'], REVOKING: ['REVOKED'], REVOKED: [] }[before.phase] as string[]).includes(after.phase)
      || before.phase === 'ACTIVE' && JSON.stringify(before.sealed) !== JSON.stringify(after.sealed)) fail();
    const update = { TableName: this.options.tableName, Key: { pk: { S: this.key('GRANT', before.grantHandle) } },
      UpdateExpression: after.phase === 'REVOKED' ? 'SET payload = :next, expiresAtEpoch = :ttl' : 'SET payload = :next',
      ConditionExpression: 'payload = :expected', ExpressionAttributeValues: { ':expected': { S: JSON.stringify(before) }, ':next': { S: JSON.stringify(after) },
        ...(after.phase === 'REVOKED' ? { ':ttl': { N: String(Math.ceil(this.now() / 1000) + 86400) } } : {}) } };
    try {
      if (after.phase === 'REVOKED') await this.call('TransactWriteItems', { TransactItems: [{ Update: update },
        { Delete: { TableName: this.options.tableName, Key: { pk: { S: this.key('SCOPE', before.scopeHash) } }, ConditionExpression: 'grantHandle = :handle', ExpressionAttributeValues: { ':handle': { S: before.grantHandle } } } },
      ] }, signal);
      else await this.call('UpdateItem', update, signal);
      return true;
    } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
}
