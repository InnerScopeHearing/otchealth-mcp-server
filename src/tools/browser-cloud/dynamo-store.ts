import { signRequest, resolveAwsCredentials } from '../../search/sigv4.js';
import type { CloudBrowserProfile, CloudBrowserSession, CloudBrowserStore } from './contract.js';
import { CloudBrowserError } from './contract.js';

type DynamoAttribute = { S?: string; N?: string; BOOL?: boolean; L?: DynamoAttribute[] };
type DynamoItem = Record<string, DynamoAttribute>;

function profileItem(profile: CloudBrowserProfile): DynamoItem {
  return { pk: { S: `PROFILE#${profile.profileId}` }, owner: { S: profile.owner }, ...(profile.providerProfileId ? { providerProfileId: { S: profile.providerProfileId } } : {}), hosts: { L: profile.allowedHosts.map((host) => ({ S: host })) }, persistent: { BOOL: profile.persistent } };
}
function readProfile(item: DynamoItem | undefined): CloudBrowserProfile | null {
  if (!item?.pk?.S?.startsWith('PROFILE#') || !item.owner?.S || !item.hosts?.L) return null;
  const allowedHosts = item.hosts.L.map((x) => x.S).filter((x): x is string => typeof x === 'string');
  return { profileId: item.pk.S.slice(8), owner: item.owner.S, ...(item.providerProfileId?.S ? { providerProfileId: item.providerProfileId.S } : {}), allowedHosts, persistent: item.persistent?.BOOL === true };
}
function sessionItem(session: CloudBrowserSession): DynamoItem {
  return { pk: { S: `SESSION#${session.sessionId}` }, owner: { S: session.owner }, profileId: { S: session.profileId }, hosts: { L: session.allowedHosts.map((host) => ({ S: host })) }, expiresAt: { N: String(session.expiresAt) }, expiresAtEpoch: { N: String(Math.ceil(session.expiresAt / 1_000)) }, actionsUsed: { N: String(session.actionsUsed) }, providerSessionId: { S: session.providerSessionId }, automationEndpoint: { S: session.automationEndpoint } };
}
function readSession(item: DynamoItem | undefined): CloudBrowserSession | null {
  if (!item?.pk?.S?.startsWith('SESSION#') || !item.owner?.S || !item.profileId?.S || !item.hosts?.L || !item.expiresAt?.N || !item.actionsUsed?.N || !item.providerSessionId?.S || !item.automationEndpoint?.S) return null;
  const expiresAt = Number(item.expiresAt.N); const actionsUsed = Number(item.actionsUsed.N);
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(actionsUsed)) return null;
  return { sessionId: item.pk.S.slice(8), owner: item.owner.S, profileId: item.profileId.S, allowedHosts: item.hosts.L.map((x) => x.S).filter((x): x is string => typeof x === 'string'), expiresAt, actionsUsed, providerSessionId: item.providerSessionId.S, automationEndpoint: item.automationEndpoint.S };
}

/**
 * Dynamo persistence shared by all gateway copies. The provisioned table uses `pk` as its key and
 * `expiresAtEpoch` as TTL. The only opaque provider references are encrypted at rest by Dynamo.
 */
export class DynamoCloudBrowserSessionStore implements CloudBrowserStore {
  constructor(private readonly tableName = process.env.CLOUD_BROWSER_DDB_TABLE || 'otchealth-browser-cloud', private readonly region = process.env.AWS_REGION || 'us-east-1', private readonly fetchImpl: typeof fetch = fetch) {}
  private async call(target: string, payload: unknown): Promise<unknown> {
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError('aws_credentials_unavailable', 'Cloud browser runtime credentials are unavailable.');
    const host = `dynamodb.${this.region}.amazonaws.com`; const body = JSON.stringify(payload);
    const signed = signRequest({ method: 'POST', host, path: '/', body, region: this.region, service: 'dynamodb', credentials, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` } });
    const response = await this.fetchImpl(`https://${host}/`, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new CloudBrowserError('session_store_failed', 'Cloud browser session store rejected the request.');
    return response.json();
  }
  async loadProfile(profileId: string): Promise<CloudBrowserProfile | null> { const r = await this.call('GetItem', { TableName: this.tableName, Key: { pk: { S: `PROFILE#${profileId}` } }, ConsistentRead: true }) as { Item?: DynamoItem }; return readProfile(r.Item); }
  async saveProfile(profile: CloudBrowserProfile): Promise<void> { await this.call('PutItem', { TableName: this.tableName, Item: profileItem(profile), ConditionExpression: 'attribute_not_exists(pk) OR owner = :owner', ExpressionAttributeValues: { ':owner': { S: profile.owner } } }); }
  async loadSession(sessionId: string): Promise<CloudBrowserSession | null> { const r = await this.call('GetItem', { TableName: this.tableName, Key: { pk: { S: `SESSION#${sessionId}` } }, ConsistentRead: true }) as { Item?: DynamoItem }; return readSession(r.Item); }
  async saveSession(session: CloudBrowserSession): Promise<void> { await this.call('PutItem', { TableName: this.tableName, Item: sessionItem(session) }); }
  async saveSessionUnderLock(session: CloudBrowserSession, lockOwner: string): Promise<void> { await this.call('UpdateItem', { TableName: this.tableName, Key: { pk: { S: `SESSION#${session.sessionId}` } }, UpdateExpression: 'SET actionsUsed = :actions, expiresAt = :expires, expiresAtEpoch = :ttl', ConditionExpression: 'lockOwner = :owner', ExpressionAttributeValues: { ':actions': { N: String(session.actionsUsed) }, ':expires': { N: String(session.expiresAt) }, ':ttl': { N: String(Math.ceil(session.expiresAt / 1_000)) }, ':owner': { S: lockOwner } } }); }
  async deleteSession(sessionId: string): Promise<void> { await this.call('DeleteItem', { TableName: this.tableName, Key: { pk: { S: `SESSION#${sessionId}` } } }); }
  async acquireSessionLock(sessionId: string, owner: string, until: number): Promise<boolean> { try { await this.call('UpdateItem', { TableName: this.tableName, Key: { pk: { S: `SESSION#${sessionId}` } }, UpdateExpression: 'SET lockOwner = :owner, lockUntil = :until', ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)', ExpressionAttributeValues: { ':owner': { S: owner }, ':until': { N: String(until) }, ':now': { N: String(Date.now()) } } }); return true; } catch { return false; } }
  async releaseSessionLock(sessionId: string, owner: string): Promise<void> { try { await this.call('UpdateItem', { TableName: this.tableName, Key: { pk: { S: `SESSION#${sessionId}` } }, UpdateExpression: 'REMOVE lockOwner, lockUntil', ConditionExpression: 'lockOwner = :owner', ExpressionAttributeValues: { ':owner': { S: owner } } }); } catch { /* lease expiry safely recovers a failed owner */ } }
  async acquireProfileLock(profileId: string, owner: string, until: number): Promise<boolean> { try { await this.call('UpdateItem', { TableName: this.tableName, Key: { pk: { S: `PROFILE#${profileId}` } }, UpdateExpression: 'SET lockOwner = :owner, lockUntil = :until', ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)', ExpressionAttributeValues: { ':owner': { S: owner }, ':until': { N: String(until) }, ':now': { N: String(Date.now()) } } }); return true; } catch { return false; } }
  async releaseProfileLock(profileId: string, owner: string): Promise<void> { try { await this.call('UpdateItem', { TableName: this.tableName, Key: { pk: { S: `PROFILE#${profileId}` } }, UpdateExpression: 'REMOVE lockOwner, lockUntil', ConditionExpression: 'lockOwner = :owner', ExpressionAttributeValues: { ':owner': { S: owner } } }); } catch { /* lease expiry safely recovers a failed owner */ } }
  async reserveDailySession(owner: string, day: string, limit: number): Promise<boolean> { try { await this.call('UpdateItem', { TableName: this.tableName, Key: { pk: { S: `BUDGET#${day}#${owner}` } }, UpdateExpression: 'ADD sessionCount :one SET expiresAtEpoch = :ttl', ConditionExpression: 'attribute_not_exists(sessionCount) OR sessionCount < :limit', ExpressionAttributeValues: { ':one': { N: '1' }, ':limit': { N: String(limit) }, ':ttl': { N: String(Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000) + 2 * 86_400) } } }); return true; } catch { return false; } }
}
