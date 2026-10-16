import type { DaytonaViewerService } from './daytona-viewer.js';
import { createHash, randomBytes } from 'node:crypto';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../search/sigv4.js';

export interface DaytonaViewerMission {
  sessionId: string; owner: string; ownerSubjectHash: string; expiresAt: number; phase: string; effectUnknown: boolean;
  viewerGrantHandle?: string;
}
export interface DaytonaViewerGrant { url: string; expiresAt: number; grantHandle: string }
export interface DaytonaViewerMissionBoundary {
  loadSession(id: string): Promise<DaytonaViewerMission | null>;
  getViewerGrant(owner: string, id: string, principal: string, seconds: number, notAfter: number): Promise<DaytonaViewerGrant>;
  resumeViewerGrant(owner: string, id: string, principal: string, handle: string): Promise<DaytonaViewerGrant>;
  completeHumanInput(owner: string, id: string, principal: string): Promise<{ status: 'saved'; human_input_revoked: true }>;
  // Must resolve only after positive owned-grant revocation AND confirmed logical
  // mission release. Never map a queued/unknown stop response to this contract.
  stop(owner: string, id: string, principal: string): Promise<void>;
}
export type DaytonaViewerPhase = 'NEW' | 'ISSUING' | 'EXCHANGED' | 'RESUMING' | 'COMPLETING' | 'EXPIRING' | 'SAVED' | 'EXPIRED';
export interface DaytonaViewerTicket {
  owner: string; principalHash: string; sessionId: string; expiresAt: number; phase: DaytonaViewerPhase; version: number;
  grantHandle?: string; grantExpiresAt?: number;
}
export interface DaytonaViewerTicketStore {
  create(hash: string, ticket: DaytonaViewerTicket): Promise<boolean>;
  load(hash: string): Promise<DaytonaViewerTicket | null>;
  transition(hash: string, phase: DaytonaViewerPhase, next: DaytonaViewerTicket): Promise<boolean>;
  acquireMissionLease(id: string, hash: string): Promise<boolean>;
  ownsMissionLease(id: string, hash: string): Promise<boolean>;
  releaseMissionLease(id: string, hash: string): Promise<void>;
}
export class DaytonaViewerHandoffService implements DaytonaViewerService {
  constructor(private readonly store: DaytonaViewerTicketStore, private readonly missions: DaytonaViewerMissionBoundary, private readonly now: () => number = Date.now) {}
  private async owned(row: DaytonaViewerTicket, allowExpired = false): Promise<void> {
    const mission = await this.missions.loadSession(row.sessionId);
    if (!mission || mission.sessionId !== row.sessionId || mission.owner !== row.owner || mission.ownerSubjectHash !== row.principalHash
      || mission.phase !== 'ACTIVE' || mission.effectUnknown || (!allowExpired && (row.expiresAt <= this.now() || mission.expiresAt <= this.now()))
      || (row.grantHandle && mission.viewerGrantHandle !== row.grantHandle)) throw new Error('viewer_unavailable');
  }
  async issue(owner: string, id: string, principal: string, seconds = 300): Promise<{ login_url: string; expires_at: number }> {
    if (typeof owner !== 'string' || typeof id !== 'string' || typeof principal !== 'string' || !ID.test(owner) || !ID.test(id) || !HASH.test(principal) || !Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('viewer_unavailable');
    const mission = await this.missions.loadSession(id);
    const expiresAt = Math.min(this.now() + seconds * 1000, mission?.expiresAt ?? 0);
    const row: DaytonaViewerTicket = { owner, sessionId: id, principalHash: principal, expiresAt, phase: 'NEW', version: 0 };
    await this.owned(row);
    const token = randomBytes(32).toString('base64url'), hash = digest(token);
    if (!await this.store.acquireMissionLease(id, hash)) throw new Error('viewer_unavailable');
    // A lost create acknowledgement retains the exact lease for reconciliation;
    // never delete it speculatively and issue a second bearer capability.
    if (!await this.store.create(hash, row)) throw new Error('viewer_unavailable');
    return { login_url: `https://mcp.otchealth.app/browser/daytona#token=${token}`, expires_at: expiresAt };
  }
  private async claim(token: string, phase: DaytonaViewerPhase, next: DaytonaViewerPhase, allowExpired = false): Promise<{ hash: string; row: DaytonaViewerTicket }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('viewer_unavailable');
    const hash = digest(token), current = await this.store.load(hash);
    if (!current || current.phase !== phase || !await this.store.ownsMissionLease(current.sessionId, hash)) throw new Error('viewer_unavailable');
    await this.owned(current, allowExpired);
    const row = { ...current, phase: next, version: current.version + 1 };
    if (!await this.store.transition(hash, phase, row)) throw new Error('viewer_unavailable');
    return { hash, row };
  }
  private async commit(hash: string, row: DaytonaViewerTicket, phase: DaytonaViewerPhase): Promise<void> {
    if (!await this.store.transition(hash, row.phase, { ...row, phase, version: row.version + 1 })) throw new Error('viewer_unavailable');
  }
  private view(grant: DaytonaViewerGrant, row: DaytonaViewerTicket): { signed_url: string; expires_at: number } {
    if (!UUID.test(grant.grantHandle) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.now() || grant.expiresAt > row.expiresAt
      || (row.grantHandle && (grant.grantHandle !== row.grantHandle || grant.expiresAt !== row.grantExpiresAt))) throw new Error('viewer_unavailable');
    const url = new URL(grant.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('viewer_unavailable');
    return { signed_url: url.href, expires_at: grant.expiresAt };
  }
  async exchange(token: string): Promise<{ signed_url: string; expires_at: number }> {
    const { hash, row } = await this.claim(token, 'NEW', 'ISSUING');
    const seconds = Math.min(300, Math.floor((row.expiresAt - this.now()) / 1000));
    if (seconds < 1) throw new Error('viewer_unavailable');
    const grant = await this.missions.getViewerGrant(row.owner, row.sessionId, row.principalHash, seconds, row.expiresAt);
    const view = this.view(grant, row);
    row.grantHandle = grant.grantHandle; row.grantExpiresAt = grant.expiresAt;
    await this.commit(hash, row, 'EXCHANGED');
    return view;
  }
  async resume(token: string): Promise<{ signed_url: string; expires_at: number }> {
    const { hash, row } = await this.claim(token, 'EXCHANGED', 'RESUMING');
    if (!row.grantHandle) throw new Error('viewer_unavailable');
    const view = this.view(await this.missions.resumeViewerGrant(row.owner, row.sessionId, row.principalHash, row.grantHandle), row);
    await this.commit(hash, row, 'EXCHANGED'); return view;
  }
  async complete(token: string): Promise<{ status: 'saved'; human_input_revoked: true }> {
    const { hash, row } = await this.claim(token, 'EXCHANGED', 'COMPLETING');
    const receipt = await this.missions.completeHumanInput(row.owner, row.sessionId, row.principalHash);
    if (receipt?.human_input_revoked !== true || receipt.status !== 'saved') throw new Error('viewer_unavailable');
    await this.commit(hash, row, 'SAVED');
    await this.store.releaseMissionLease(row.sessionId, hash);
    return { status: 'saved', human_input_revoked: true };
  }
  async expire(token: string): Promise<{ status: 'expired'; human_input_revoked: true }> {
    const { hash, row } = await this.claim(token, 'EXCHANGED', 'EXPIRING', true);
    await this.missions.stop(row.owner, row.sessionId, row.principalHash);
    await this.commit(hash, row, 'EXPIRED'); await this.store.releaseMissionLease(row.sessionId, hash);
    return { status: 'expired', human_input_revoked: true };
  }
}

const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Item = Record<string, { S?: string; N?: string }>;
export interface DaytonaViewerStoreOptions { tableName?: string; region?: string; now?: () => number; fetchImpl?: typeof fetch; resolveCredentials?: () => Promise<AwsCredentials | null> }
class Conflict extends Error {}
/** Only hashes, immutable ownership and opaque handles are stored; never viewer URLs/tokens. */
export class DynamoDaytonaViewerTicketStore implements DaytonaViewerTicketStore {
  private readonly table: string; private readonly region: string;
  constructor(private readonly options: DaytonaViewerStoreOptions = {}) {
    this.table = options.tableName ?? process.env.CLOUD_BROWSER_DDB_TABLE ?? 'otchealth-browser-cloud'; this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(this.table) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(this.region)) throw new Error('viewer_store_unavailable');
  }
  private key(kind: 'TICKET' | 'LEASE', value: string): string { if (typeof value !== 'string' || !(kind === 'TICKET' ? HASH : ID).test(value)) throw new Error('viewer_store_unavailable'); return `DAYTONA_VIEWER#${kind}#${value}`; }
  private async call(operation: string, payload: Record<string, unknown>): Promise<{ Item?: Item }> {
    try {
      const credentials = await (this.options.resolveCredentials ?? resolveAwsCredentials)(); if (!credentials) throw new Error();
      const host = `dynamodb.${this.region}.amazonaws.com`, body = JSON.stringify({ TableName: this.table, ...payload });
      const signed = signRequest({ method: 'POST', host, path: '/', body, region: this.region, service: 'dynamodb', credentials, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${operation}` } });
      const response = await (this.options.fetchImpl ?? fetch)(`https://${host}/`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
      const result = await response.json() as { Item?: Item; __type?: string };
      if (!response.ok) { if (result.__type?.endsWith('ConditionalCheckFailedException')) throw new Conflict(); throw new Error(); }
      return result;
    } catch (error) { if (error instanceof Conflict) throw error; throw new Error('viewer_store_unavailable'); }
  }
  private checked(row: DaytonaViewerTicket): void {
    const fields = ['owner', 'principalHash', 'sessionId', 'expiresAt', 'phase', 'version', 'grantHandle', 'grantExpiresAt'];
    if (!row || Object.keys(row).some(key => !fields.includes(key)) || typeof row.owner !== 'string' || typeof row.sessionId !== 'string' || typeof row.principalHash !== 'string' || !ID.test(row.owner) || !ID.test(row.sessionId) || !HASH.test(row.principalHash)
      || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0 || !Number.isSafeInteger(row.version) || row.version < 0
      || !['NEW','ISSUING','EXCHANGED','RESUMING','COMPLETING','EXPIRING','SAVED','EXPIRED'].includes(row.phase)
      || ((row.grantHandle === undefined) !== (row.grantExpiresAt === undefined))
      || (row.grantHandle !== undefined && (typeof row.grantHandle !== 'string' || !UUID.test(row.grantHandle) || !Number.isSafeInteger(row.grantExpiresAt) || row.grantExpiresAt! <= 0 || row.grantExpiresAt! > row.expiresAt))) throw new Error('viewer_store_unavailable');
  }
  async create(hash: string, row: DaytonaViewerTicket): Promise<boolean> {
    this.checked(row);
    // Retain reconciliation receipts with their permanent owner fence. Access
    // still expires at row.expiresAt; metadata retention never renews a ticket.
    try { await this.call('PutItem', { Item: { pk: { S: this.key('TICKET', hash) }, payload: { S: JSON.stringify(row) }, phase: { S: row.phase }, version: { N: String(row.version) } }, ConditionExpression: 'attribute_not_exists(pk)' }); return true; } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async load(hash: string): Promise<DaytonaViewerTicket | null> {
    const pk = this.key('TICKET', hash), result = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true });
    if (!result.Item) return null;
    if (result.Item.pk?.S !== pk || typeof result.Item.payload?.S !== 'string') throw new Error('viewer_store_unavailable');
    let row: DaytonaViewerTicket; try { row = JSON.parse(result.Item.payload.S) as DaytonaViewerTicket; } catch { throw new Error('viewer_store_unavailable'); }
    this.checked(row); if (result.Item.phase?.S !== row.phase || Number(result.Item.version?.N) !== row.version) throw new Error('viewer_store_unavailable'); return row;
  }
  async transition(hash: string, phase: DaytonaViewerPhase, next: DaytonaViewerTicket): Promise<boolean> {
    this.checked(next);
    try { await this.call('UpdateItem', { Key: { pk: { S: this.key('TICKET', hash) } }, UpdateExpression: 'SET payload = :payload, #phase = :next, #version = :nextVersion', ConditionExpression: '#phase = :old AND #version = :oldVersion', ExpressionAttributeNames: { '#phase': 'phase', '#version': 'version' }, ExpressionAttributeValues: { ':payload': { S: JSON.stringify(next) }, ':next': { S: next.phase }, ':old': { S: phase }, ':nextVersion': { N: String(next.version) }, ':oldVersion': { N: String(next.version - 1) } } }); return true; } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async acquireMissionLease(id: string, hash: string): Promise<boolean> {
    if (!HASH.test(hash)) throw new Error('viewer_store_unavailable');
    // No time-based takeover of an unknown human-input effect. Only confirmed
    // revocation or exact operator reconciliation can release this owner fence.
    try { await this.call('PutItem', { Item: { pk: { S: this.key('LEASE', id) }, owner: { S: hash } }, ConditionExpression: 'attribute_not_exists(pk)' }); return true; } catch (error) { if (error instanceof Conflict) return false; throw error; }
  }
  async ownsMissionLease(id: string, hash: string): Promise<boolean> { const pk = this.key('LEASE', id), result = await this.call('GetItem', { Key: { pk: { S: pk } }, ConsistentRead: true }); return result.Item?.pk?.S === pk && result.Item.owner?.S === hash; }
  async releaseMissionLease(id: string, hash: string): Promise<void> {
    if (!HASH.test(hash)) throw new Error('viewer_store_unavailable');
    try { await this.call('DeleteItem', { Key: { pk: { S: this.key('LEASE', id) } }, ConditionExpression: '#owner = :owner', ExpressionAttributeNames: { '#owner': 'owner' }, ExpressionAttributeValues: { ':owner': { S: hash } } }); } catch (error) { if (!(error instanceof Conflict)) throw error; }
  }
}
