import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import { DaytonaBrowserError, daytonaPhysicalProfileKey, type DaytonaBinding, type DaytonaMission, type DaytonaBrowserStore } from './contract.js';
export interface DaytonaStoreOptions { tableName?: string; region?: string; now?: () => number; resolveCredentials?: () => Promise<AwsCredentials | null>; fetchImpl?: typeof fetch }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const bindingFields = ['provider', 'owner', 'ownerSubjectHash', 'sandboxId', 'profileKey', 'sharedProfileKey', 'profilePath', 'readinessReceiptSha256'];
const missionFields = ['provider', 'sessionId', 'owner', 'ownerSubjectHash', 'profileKey', 'sandboxId', 'expiresAt', 'actionsUsed', 'actionBudget', 'effectUnknown', 'phase', 'runtimeProtocol', 'sensitiveOutputSuppressed', 'viewerGrantHandle', 'viewerExpiresAt'];
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function only(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function text(value: unknown, pattern: RegExp): boolean { return typeof value === 'string' && pattern.test(value); }
export function assertDaytonaBinding(value: unknown): asserts value is DaytonaBinding {
  if (!record(value) || !only(value, bindingFields) || value.provider !== 'daytona' || !text(value.owner, ID) || !text(value.ownerSubjectHash, HASH) || !text(value.sandboxId, ID) || !text(value.profileKey, KEY) || !text(value.readinessReceiptSha256, HASH)) throw new DaytonaBrowserError('daytona_binding_invalid');
  if ('sharedProfileKey' in value && (value.sharedProfileKey !== 'company-browser' || value.profileKey !== `${value.owner}-${value.ownerSubjectHash}`)) throw new DaytonaBrowserError('daytona_binding_invalid');
  if (value.profilePath !== `/home/otcbrowser/.local/share/otchealth-browser/${daytonaPhysicalProfileKey(value as unknown as DaytonaBinding)}/chromium`) throw new DaytonaBrowserError('daytona_binding_invalid');
}
export function assertDaytonaMission(value: unknown): asserts value is DaytonaMission {
  if (record(value) && 'runtimeProtocol' in value && value.runtimeProtocol !== 2) throw new DaytonaBrowserError('daytona_session_invalid');
  if (!record(value) || !only(value, missionFields) || value.provider !== 'daytona' || !ID.test(String(value.sessionId ?? '')) || !ID.test(String(value.owner ?? '')) || !HASH.test(String(value.ownerSubjectHash ?? '')) || !KEY.test(String(value.profileKey ?? '')) || !ID.test(String(value.sandboxId ?? '')) || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0 || !Number.isSafeInteger(value.actionsUsed) || Number(value.actionsUsed) < 0 || !Number.isSafeInteger(value.actionBudget) || Number(value.actionBudget) < 1 || Number(value.actionBudget) > 10000 || Number(value.actionsUsed) > Number(value.actionBudget) || typeof value.effectUnknown !== 'boolean' || !['OPENING', 'ACTIVE', 'RELEASING', 'CLOSED'].includes(String(value.phase)) || (value.sensitiveOutputSuppressed !== undefined && typeof value.sensitiveOutputSuppressed !== 'boolean') || (value.viewerGrantHandle !== undefined && !UUID.test(String(value.viewerGrantHandle))) || (value.viewerExpiresAt !== undefined && (!Number.isSafeInteger(value.viewerExpiresAt) || Number(value.viewerExpiresAt) <= 0 || Number(value.viewerExpiresAt) > Number(value.expiresAt))) || ((value.viewerGrantHandle === undefined) !== (value.viewerExpiresAt === undefined))) throw new DaytonaBrowserError('daytona_session_invalid');
}
class ConditionalConflict extends Error {}
type Item = Record<string, { S?: string; N?: string }>;
export class DynamoDaytonaBrowserStore implements DaytonaBrowserStore {
  private readonly table: string; private readonly region: string; private readonly now: () => number;
  private readonly credentials: () => Promise<AwsCredentials | null>; private readonly fetcher: typeof fetch;
  constructor(options: DaytonaStoreOptions = {}) {
    this.table = options.tableName ?? process.env.CLOUD_BROWSER_DDB_TABLE ?? 'otchealth-browser-cloud'; this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1'; this.now = options.now ?? Date.now; this.credentials = options.resolveCredentials ?? resolveAwsCredentials; this.fetcher = options.fetchImpl ?? fetch;
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(this.table) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(this.region)) throw new DaytonaBrowserError('daytona_store_unavailable');
  }
  private async call(operation: string, payload: Record<string, unknown>): Promise<{ Item?: Item }> {
    try {
      const credentials = await this.credentials(); if (!credentials) throw new DaytonaBrowserError('daytona_store_unavailable');
      const host = `dynamodb.${this.region}.amazonaws.com`; const body = JSON.stringify({ TableName: this.table, ...payload });
      const signed = signRequest({ method: 'POST', host, path: '/', body, region: this.region, service: 'dynamodb', credentials, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` } });
      const response = await this.fetcher(`https://${host}/`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
      const result = await response.json() as { Item?: Item; __type?: string };
      if (!response.ok) { if (typeof result.__type === 'string' && result.__type.endsWith('ConditionalCheckFailedException')) throw new ConditionalConflict(); throw new DaytonaBrowserError('daytona_store_unavailable'); }
      return result;
    } catch (error) { if (error instanceof ConditionalConflict || error instanceof DaytonaBrowserError) throw error; throw new DaytonaBrowserError('daytona_store_unavailable'); }
  }
  private key(kind: 'PROFILE' | 'SESSION' | 'LEASE', id: string): string { if (!(kind === 'PROFILE' || kind === 'LEASE' ? KEY : ID).test(id)) throw new DaytonaBrowserError('daytona_id_invalid'); return `DAYTONA#${kind}#${id}`; }
  private async load(kind: 'PROFILE' | 'SESSION', id: string): Promise<unknown> {
    const pk = this.key(kind, id); const result = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true });
    if (!result.Item) return null; if (result.Item.pk?.S !== pk || typeof result.Item.payload?.S !== 'string') throw new DaytonaBrowserError('daytona_store_invalid');
    try { return JSON.parse(result.Item.payload.S); } catch { throw new DaytonaBrowserError('daytona_store_invalid'); }
  }
  async createBinding(binding: DaytonaBinding): Promise<boolean> {
    assertDaytonaBinding(binding);
    try { await this.call('PutItem', { Item: { pk: { S: this.key('PROFILE', binding.profileKey) }, payload: { S: JSON.stringify(binding) } }, ConditionExpression: 'attribute_not_exists(pk)' }); return true; } catch (error) { if (error instanceof ConditionalConflict) return false; throw error; }
  }
  async loadBinding(key: string): Promise<DaytonaBinding | null> { const value = await this.load('PROFILE', key); if (value === null) return null; assertDaytonaBinding(value); if (value.profileKey !== key) throw new DaytonaBrowserError('daytona_store_invalid'); return value; }
  async createSession(session: DaytonaMission): Promise<boolean> {
    assertDaytonaMission(session); if (session.expiresAt <= this.now()) throw new DaytonaBrowserError('session_expired');
    // The desktop outlives its logical mission. Keep its recovery receipt until
    // positive revocation and fenced operator cleanup, never a TTL deletion.
    try { await this.call('PutItem', { Item: { pk: { S: this.key('SESSION', session.sessionId) }, payload: { S: JSON.stringify(session) } }, ConditionExpression: 'attribute_not_exists(pk)' }); return true; } catch (error) { if (error instanceof ConditionalConflict) return false; throw error; }
  }
  async loadSession(id: string): Promise<DaytonaMission | null> { const value = await this.load('SESSION', id); if (value === null) return null; assertDaytonaMission(value); if (value.sessionId !== id) throw new DaytonaBrowserError('daytona_store_invalid'); return value; }
  async saveSessionUnderLock(session: DaytonaMission, lockOwner: string): Promise<void> {
    assertDaytonaMission(session); if (!ID.test(lockOwner)) throw new DaytonaBrowserError('daytona_id_invalid');
    await this.call('UpdateItem', { Key: { pk: { S: this.key('SESSION', session.sessionId) } }, UpdateExpression: 'SET payload = :payload REMOVE expiresAtEpoch', ConditionExpression: 'lockOwner = :owner AND lockUntil > :now', ExpressionAttributeValues: { ':payload': { S: JSON.stringify(session) }, ':owner': { S: lockOwner }, ':now': { N: String(this.now()) } } });
  }
  private async acquire(kind: 'SESSION' | 'LEASE', id: string, owner: string, until: number): Promise<boolean> {
    if (!ID.test(owner) || !Number.isSafeInteger(until) || until <= this.now() || until > this.now() + 29100000) throw new DaytonaBrowserError('daytona_lease_invalid');
    try { await this.call('UpdateItem', { Key: { pk: { S: this.key(kind, id) } }, UpdateExpression: `SET lockOwner = :owner, lockUntil = :until${kind === 'LEASE' ? ' REMOVE expiresAtEpoch' : ''}`, ConditionExpression: kind === 'LEASE' ? 'attribute_not_exists(lockOwner)' : 'attribute_exists(pk) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)', ExpressionAttributeValues: { ':owner': { S: owner }, ':until': { N: String(until) }, ...(kind === 'SESSION' ? { ':now': { N: String(this.now()) } } : {}) } }); return true; } catch (error) { if (error instanceof ConditionalConflict) return false; throw error; }
  }
  async acquireProfileLease(key: string, owner: string, until: number): Promise<boolean> { return this.acquire('LEASE', key, owner, until); }
  async acquireSessionLock(id: string, owner: string, until: number): Promise<boolean> { return this.acquire('SESSION', id, owner, until); }
  async ownsProfileLease(key: string, owner: string): Promise<boolean> { if (!ID.test(owner)) return false; const pk = this.key('LEASE', key); const r = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true }); const until = Number(r.Item?.lockUntil?.N); return r.Item?.pk?.S === pk && r.Item.lockOwner?.S === owner && Number.isSafeInteger(until) && until > 0; }
  async releaseProfileLease(key: string, owner: string): Promise<void> { if (!ID.test(owner)) throw new DaytonaBrowserError('daytona_id_invalid'); try { await this.call('DeleteItem', { Key: { pk: { S: this.key('LEASE', key) } }, ConditionExpression: 'lockOwner = :owner', ExpressionAttributeValues: { ':owner': { S: owner } } }); } catch (error) { if (!(error instanceof ConditionalConflict)) throw error; } }
  async releaseSessionLock(id: string, owner: string): Promise<void> { if (!ID.test(owner)) throw new DaytonaBrowserError('daytona_id_invalid'); try { await this.call('UpdateItem', { Key: { pk: { S: this.key('SESSION', id) } }, UpdateExpression: 'REMOVE lockOwner, lockUntil', ConditionExpression: 'lockOwner = :owner', ExpressionAttributeValues: { ':owner': { S: owner } } }); } catch (error) { if (!(error instanceof ConditionalConflict)) throw error; } }
}
