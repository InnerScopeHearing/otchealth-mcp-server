import { canonicalUri, resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import { validateWebsiteLoginTarget, type WebsiteLoginTarget } from './website-login-policy.js';

export const WEBSITE_LOGIN_SITES = ['wefunder', 'linkedin', 'custom'] as const;
export type WebsiteLoginSite = (typeof WEBSITE_LOGIN_SITES)[number];
export type WebsiteLoginPhase = 'NEW' | 'EXCHANGED' | 'COMPLETING' | 'SAVED' | 'FAILED';
export interface WebsiteLoginBinding {
  owner: string;
  ownerSubjectHash: string;
  profileId: string;
  sessionId: string;
  site: WebsiteLoginSite;
  target?: WebsiteLoginTarget;
  profileLeaseOwner: string;
  expiresAt: number;
}
export interface WebsiteLoginTicket extends WebsiteLoginBinding { phase: WebsiteLoginPhase }
export interface CreateWebsiteLoginTicket extends WebsiteLoginBinding { tokenHash: string }
export interface WebsiteLoginStoreOptions {
  tableName?: string;
  region?: string;
  fetchImpl?: typeof fetch;
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  now?: () => number;
}
type Attribute = { S?: string; N?: string };
type Item = Record<string, Attribute>;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const OWNERS = new Set(['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director']);
const PHASES = new Set<WebsiteLoginPhase>(['NEW', 'EXCHANGED', 'COMPLETING', 'SAVED', 'FAILED']);
const PREFIX = 'WEBSITE_LOGIN#';
export class WebsiteLoginStoreError extends Error {
  constructor(readonly code = 'website_login_store_failed') { super('Website sign-in setup could not be completed safely.'); this.name = 'WebsiteLoginStoreError'; }
}
class ConditionalCheckFailed extends Error {}
const validSite = (site: unknown): site is WebsiteLoginSite => typeof site === 'string' && (WEBSITE_LOGIN_SITES as readonly string[]).includes(site);
function validBinding(value: WebsiteLoginBinding): boolean {
  if (!OWNERS.has(value.owner) || !HASH.test(value.ownerSubjectHash) || !ID.test(value.profileId) || !ID.test(value.sessionId) || !ID.test(value.profileLeaseOwner) || !validSite(value.site) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return false;
  try { return value.site === 'custom' ? Boolean(validateWebsiteLoginTarget(value.target)) : value.target === undefined; } catch { return false; }
}
function checkedHash(hash: string): string {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new WebsiteLoginStoreError('website_login_ticket_invalid');
  return hash;
}
function ticketFromItem(item: Item | undefined, pk: string): WebsiteLoginTicket | null {
  if (!item || item.pk?.S !== pk) return null;
  let target: WebsiteLoginTarget | undefined;
  try { if (item.targetJSON?.S) target = validateWebsiteLoginTarget(JSON.parse(item.targetJSON.S)); } catch { return null; }
  const binding: WebsiteLoginBinding = {
    owner: item.owner?.S ?? '', ownerSubjectHash: item.ownerSubjectHash?.S ?? '', profileId: item.profileId?.S ?? '',
    sessionId: item.sessionId?.S ?? '', site: item.site?.S as WebsiteLoginSite, profileLeaseOwner: item.profileLeaseOwner?.S ?? '', ...(target ? { target } : {}), expiresAt: Number(item.expiresAt?.N),
  };
  const phase = item.phase?.S as WebsiteLoginPhase;
  return validBinding(binding) && PHASES.has(phase) ? { ...binding, phase } : null;
}

/** Durable single-use handoff. Raw tokens, credentials and provider URLs never enter the table. */
export class WebsiteLoginTicketStore {
  private readonly table: string;
  private readonly region: string;
  private readonly fetcher: typeof fetch;
  private readonly credentials: () => Promise<AwsCredentials | null>;
  private readonly now: () => number;
  constructor(options: WebsiteLoginStoreOptions = {}) {
    this.table = options.tableName ?? process.env.CLOUD_BROWSER_DDB_TABLE ?? 'otchealth-browser-cloud';
    this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.fetcher = options.fetchImpl ?? fetch;
    this.credentials = options.resolveCredentials ?? resolveAwsCredentials;
    this.now = options.now ?? Date.now;
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(this.table) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(this.region)) throw new WebsiteLoginStoreError('website_login_store_unavailable');
  }
  private async call(target: 'PutItem' | 'GetItem' | 'UpdateItem' | 'DeleteItem', payload: unknown): Promise<unknown> {
    try {
      const credentials = await this.credentials();
      if (!credentials) throw new WebsiteLoginStoreError('website_login_store_unavailable');
      const host = `dynamodb.${this.region}.amazonaws.com`;
      const body = JSON.stringify(payload);
      const signed = signRequest({ method: 'POST', host, path: '/', body, region: this.region, service: 'dynamodb', credentials,
        extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` } });
      const response = await this.fetcher(`https://${host}${canonicalUri('/')}`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const value = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!response.ok) {
        const code = value && (typeof value.__type === 'string' ? value.__type : value.code);
        if (typeof code === 'string' && code.split('#').at(-1)?.split(':').at(-1) === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed();
        throw new WebsiteLoginStoreError();
      }
      return value;
    } catch (error) {
      if (error instanceof ConditionalCheckFailed || error instanceof WebsiteLoginStoreError) throw error;
      throw new WebsiteLoginStoreError();
    }
  }
  async create(input: CreateWebsiteLoginTicket): Promise<void> {
    if (!input || !validBinding(input) || input.expiresAt <= this.now()) throw new WebsiteLoginStoreError('website_login_ticket_invalid');
    const pk = `${PREFIX}${checkedHash(input.tokenHash)}`;
    try {
      await this.call('PutItem', { TableName: this.table, Item: {
        pk: { S: pk }, owner: { S: input.owner }, ownerSubjectHash: { S: input.ownerSubjectHash }, profileId: { S: input.profileId },
        sessionId: { S: input.sessionId }, site: { S: input.site }, profileLeaseOwner: { S: input.profileLeaseOwner }, ...(input.target ? { targetJSON: { S: JSON.stringify(validateWebsiteLoginTarget(input.target)) } } : {}), expiresAt: { N: String(input.expiresAt) },
        expiresAtEpoch: { N: String(Math.ceil(input.expiresAt / 1_000)) }, phase: { S: 'NEW' },
      }, ConditionExpression: 'attribute_not_exists(pk)' });
    } catch (error) {
      if (error instanceof ConditionalCheckFailed) throw new WebsiteLoginStoreError('website_login_ticket_conflict');
      throw error;
    }
  }
  async exchange(hash: string): Promise<WebsiteLoginBinding | null> {
    const pk = `${PREFIX}${checkedHash(hash)}`;
    try {
      const response = await this.call('UpdateItem', {
        TableName: this.table, Key: { pk: { S: pk } }, UpdateExpression: 'SET #phase = :exchanged',
        ConditionExpression: '#phase = :new AND expiresAt > :now', ExpressionAttributeNames: { '#phase': 'phase' },
        ExpressionAttributeValues: { ':new': { S: 'NEW' }, ':exchanged': { S: 'EXCHANGED' }, ':now': { N: String(this.now()) } }, ReturnValues: 'ALL_NEW',
      }) as { Attributes?: Item };
      const ticket = ticketFromItem(response?.Attributes, pk);
      if (!ticket || ticket.phase !== 'EXCHANGED' || ticket.expiresAt <= this.now()) throw new WebsiteLoginStoreError();
      const { phase: _phase, ...binding } = ticket;
      return binding;
    } catch (error) { if (error instanceof ConditionalCheckFailed) return null; throw error; }
  }
  async load(hash: string): Promise<WebsiteLoginTicket | null> {
    const pk = `${PREFIX}${checkedHash(hash)}`;
    const response = await this.call('GetItem', { TableName: this.table, Key: { pk: { S: pk } }, ConsistentRead: true }) as { Item?: Item };
    const ticket = ticketFromItem(response?.Item, pk);
    return ticket && ticket.expiresAt > this.now() ? ticket : null;
  }
  async finish(hash: string): Promise<boolean> {
    return this.transition(hash, 'EXCHANGED', 'COMPLETING', true);
  }
  /** Separate durable lease spans profile creation, the human handoff and provider save. */
  async acquireProfileLease(profileId: string, owner: string, until: number): Promise<boolean> {
    if (!ID.test(profileId) || !ID.test(owner) || !Number.isSafeInteger(until) || until <= this.now() || until > this.now() + 3_660_000) throw new WebsiteLoginStoreError('website_login_lease_invalid');
    try {
      await this.call('UpdateItem', {
        TableName: this.table, Key: { pk: { S: `WEBSITE_LOGIN_LEASE#${profileId}` } },
        UpdateExpression: 'SET lockOwner = :owner, lockUntil = :until, expiresAtEpoch = :ttl',
        ConditionExpression: 'attribute_not_exists(lockUntil) OR lockUntil < :now',
        ExpressionAttributeValues: { ':owner': { S: owner }, ':until': { N: String(until) }, ':now': { N: String(this.now()) }, ':ttl': { N: String(Math.ceil(until / 1000)) } },
      }); return true;
    } catch (error) { if (error instanceof ConditionalCheckFailed) return false; throw error; }
  }
  async ownsProfileLease(profileId: string, owner: string): Promise<boolean> {
    if (!ID.test(profileId) || !ID.test(owner)) return false;
    const response = await this.call('GetItem', { TableName: this.table, Key: { pk: { S: `WEBSITE_LOGIN_LEASE#${profileId}` } }, ConsistentRead: true }) as { Item?: Item };
    const row = response?.Item; const until = Number(row?.lockUntil?.N);
    return row?.pk?.S === `WEBSITE_LOGIN_LEASE#${profileId}` && row.lockOwner?.S === owner && Number.isSafeInteger(until) && until > this.now();
  }
  /** Owner-fenced renewal never deletes the row or revives an expired lease. */
  async renewProfileLease(profileId: string, owner: string, until: number): Promise<boolean> {
    if (!ID.test(profileId) || !ID.test(owner) || !Number.isSafeInteger(until) || until <= this.now() || until > this.now() + 3_660_000) throw new WebsiteLoginStoreError('website_login_lease_invalid');
    try {
      await this.call('UpdateItem', {
        TableName: this.table, Key: { pk: { S: `WEBSITE_LOGIN_LEASE#${profileId}` } },
        UpdateExpression: 'SET lockUntil = :until, expiresAtEpoch = :ttl',
        ConditionExpression: 'lockOwner = :owner AND lockUntil > :now',
        ExpressionAttributeValues: { ':owner': { S: owner }, ':until': { N: String(until) }, ':now': { N: String(this.now()) }, ':ttl': { N: String(Math.ceil(until / 1000)) } },
      }); return true;
    } catch (error) { if (error instanceof ConditionalCheckFailed) return false; throw error; }
  }
  async releaseProfileLease(profileId: string, owner: string): Promise<void> {
    if (!ID.test(profileId) || !ID.test(owner)) throw new WebsiteLoginStoreError('website_login_lease_invalid');
    try {
      await this.call('DeleteItem', { TableName: this.table, Key: { pk: { S: `WEBSITE_LOGIN_LEASE#${profileId}` } },
        ConditionExpression: 'lockOwner = :owner', ExpressionAttributeValues: { ':owner': { S: owner } } });
    } catch (error) { if (!(error instanceof ConditionalCheckFailed)) throw error; }
  }
  async complete(hash: string, outcome: 'SAVED' | 'FAILED'): Promise<boolean> {
    if (outcome !== 'SAVED' && outcome !== 'FAILED') throw new WebsiteLoginStoreError('website_login_ticket_invalid');
    return this.transition(hash, 'COMPLETING', outcome, false);
  }
  private async transition(hash: string, from: WebsiteLoginPhase, to: WebsiteLoginPhase, requireFresh: boolean): Promise<boolean> {
    try {
      await this.call('UpdateItem', {
        TableName: this.table, Key: { pk: { S: `${PREFIX}${checkedHash(hash)}` } }, UpdateExpression: 'SET #phase = :outcome',
        ConditionExpression: `#phase = :from${requireFresh ? ' AND expiresAt > :now' : ''}`,
        ExpressionAttributeNames: { '#phase': 'phase' }, ExpressionAttributeValues: {
          ':from': { S: from }, ':outcome': { S: to }, ...(requireFresh ? { ':now': { N: String(this.now()) } } : {}),
        },
      });
      return true;
    } catch (error) { if (error instanceof ConditionalCheckFailed) return false; throw error; }
  }
}
