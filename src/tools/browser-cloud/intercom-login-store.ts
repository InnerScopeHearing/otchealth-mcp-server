import { canonicalUri, resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';

type DynamoAttribute = { S?: string; N?: string };
type DynamoItem = Record<string, DynamoAttribute>;

export type IntercomLoginPhase = 'NEW' | 'EXCHANGED' | 'COMPLETING' | 'SAVED' | 'FAILED';
export type IntercomLoginOutcome = 'SAVED' | 'FAILED';

/** Safe binding returned after the one-time exchange. It never contains the token or token hash. */
export interface IntercomLoginBinding {
  ownerSubjectHash: string;
  profileId: string;
  sessionId: string;
  expectedWorkspaceId: string;
  expectedWorkspaceHost?: string;
  expiresAt: number;
}

export interface IntercomLoginTicket extends IntercomLoginBinding {
  phase: IntercomLoginPhase;
}

export interface CreateIntercomLoginTicket extends IntercomLoginBinding {
  /** SHA-256 hex digest of the opaque setup token. The raw token is never accepted or persisted. */
  tokenHash: string;
}

export interface IntercomLoginStoreOptions {
  tableName?: string;
  region?: string;
  fetchImpl?: typeof fetch;
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  now?: () => number;
}

export class IntercomLoginStoreError extends Error {
  readonly code: string;

  constructor(code = 'intercom_login_store_failed') {
    super('Intercom login setup could not be completed safely.');
    this.name = 'IntercomLoginStoreError';
    this.code = code;
  }
}

class ConditionalCheckFailed extends Error {}

const HASH = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const PHASES = new Set<IntercomLoginPhase>(['NEW', 'EXCHANGED', 'COMPLETING', 'SAVED', 'FAILED']);
const MAX_ATTEMPT_MS = 15_000;

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && value !== '.' && value !== '..';
}

function ticketKey(tokenHash: string): string {
  return `INTERCOM_LOGIN#${tokenHash}`;
}

function ticketFromItem(item: DynamoItem | undefined, expectedPk: string): IntercomLoginTicket | null {
  if (!item || item.pk?.S !== expectedPk || !HASH.test(expectedPk.slice('INTERCOM_LOGIN#'.length))) return null;
  const ownerSubjectHash = item.ownerSubjectHash?.S;
  const profileId = item.profileId?.S;
  const sessionId = item.sessionId?.S;
  const expectedWorkspaceId = item.expectedWorkspaceId?.S;
  const expectedWorkspaceHost = item.expectedWorkspaceHost?.S;
  const expiresAt = Number(item.expiresAt?.N);
  const phase = item.phase?.S as IntercomLoginPhase | undefined;
  if (!ownerSubjectHash || !HASH.test(ownerSubjectHash) || !validOpaqueId(profileId) || !validOpaqueId(sessionId) ||
      !validOpaqueId(expectedWorkspaceId) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !phase || !PHASES.has(phase)) {
    return null;
  }
  if (expectedWorkspaceHost && !['app.intercom.com','app.eu.intercom.com','app.au.intercom.com'].includes(expectedWorkspaceHost)) return null;
  return { ownerSubjectHash, profileId, sessionId, expectedWorkspaceId, ...(expectedWorkspaceHost ? {expectedWorkspaceHost} : {}), expiresAt, phase };
}

function validateCreate(input: CreateIntercomLoginTicket, now: number): void {
  if(input.expectedWorkspaceHost && !['app.intercom.com','app.eu.intercom.com','app.au.intercom.com'].includes(input.expectedWorkspaceHost)) throw new IntercomLoginStoreError('intercom_login_ticket_invalid');
  if (!input || !HASH.test(input.tokenHash) || !HASH.test(input.ownerSubjectHash) || !validOpaqueId(input.profileId) ||
      !validOpaqueId(input.sessionId) || !validOpaqueId(input.expectedWorkspaceId) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new IntercomLoginStoreError('intercom_login_ticket_invalid');
  }
}

function validateTokenHash(tokenHash: string): void {
  if (typeof tokenHash !== 'string' || !HASH.test(tokenHash)) throw new IntercomLoginStoreError('intercom_login_ticket_invalid');
}

function errorName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const raw = typeof record.__type === 'string' ? record.__type : typeof record.code === 'string' ? record.code : undefined;
  if (!raw) return undefined;
  return raw.split('#').at(-1)?.split(':').at(-1);
}

/**
 * Durable, single-use state for the browser-mediated Intercom login handoff. The table's TTL
 * attribute is `expiresAtEpoch` in Unix seconds; `expiresAt` remains milliseconds for guards.
 */
export class IntercomLoginTicketStore {
  private readonly tableName: string;
  private readonly region: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getCredentials: () => Promise<AwsCredentials | null>;
  private readonly now: () => number;

  constructor(options: IntercomLoginStoreOptions = {}) {
    this.tableName = options.tableName ?? process.env.CLOUD_BROWSER_DDB_TABLE ?? 'otchealth-browser-cloud';
    this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getCredentials = options.resolveCredentials ?? resolveAwsCredentials;
    this.now = options.now ?? Date.now;
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(this.tableName) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(this.region)) {
      throw new IntercomLoginStoreError('intercom_login_store_unavailable');
    }
  }

  private async call(target: 'PutItem' | 'GetItem' | 'UpdateItem', payload: unknown): Promise<unknown> {
    try {
      const credentials = await this.getCredentials();
      if (!credentials) throw new IntercomLoginStoreError('intercom_login_store_unavailable');
      const host = `dynamodb.${this.region}.amazonaws.com`;
      const body = JSON.stringify(payload);
      const signed = signRequest({
        method: 'POST', host, path: '/', body, region: this.region, service: 'dynamodb', credentials,
        extraHeaders: {
          'content-type': 'application/x-amz-json-1.0',
          'x-amz-target': `DynamoDB_20120810.${target}`,
        },
      });
      const response = await this.fetchImpl(`https://${host}${canonicalUri('/')}`, {
        method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(MAX_ATTEMPT_MS),
      });
      let responseBody: unknown;
      try { responseBody = await response.json(); } catch { responseBody = undefined; }
      if (!response.ok) {
        if (errorName(responseBody) === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed();
        throw new IntercomLoginStoreError();
      }
      return responseBody;
    } catch (error) {
      if (error instanceof ConditionalCheckFailed || error instanceof IntercomLoginStoreError) throw error;
      // Never expose AWS error bodies, request values, credential material, or network URLs.
      throw new IntercomLoginStoreError();
    }
  }

  async create(input: CreateIntercomLoginTicket): Promise<void> {
    validateCreate(input, this.now());
    try {
      await this.call('PutItem', {
        TableName: this.tableName,
        Item: {
          pk: { S: ticketKey(input.tokenHash) },
          ownerSubjectHash: { S: input.ownerSubjectHash },
          profileId: { S: input.profileId },
          sessionId: { S: input.sessionId },
          expectedWorkspaceId: { S: input.expectedWorkspaceId },
        ...(input.expectedWorkspaceHost ? {expectedWorkspaceHost: { S:input.expectedWorkspaceHost }} : {}),
          expiresAt: { N: String(input.expiresAt) },
          expiresAtEpoch: { N: String(Math.ceil(input.expiresAt / 1_000)) },
          phase: { S: 'NEW' },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      });
    } catch (error) {
      if (error instanceof ConditionalCheckFailed) throw new IntercomLoginStoreError('intercom_login_ticket_conflict');
      throw error;
    }
  }

  /** Atomically consumes NEW and returns only the safe browser/profile binding. */
  async exchange(tokenHash: string): Promise<IntercomLoginBinding | null> {
    validateTokenHash(tokenHash);
    try {
      const response = await this.call('UpdateItem', {
        TableName: this.tableName,
        Key: { pk: { S: ticketKey(tokenHash) } },
        UpdateExpression: 'SET #phase = :exchanged',
        ConditionExpression: '#phase = :new AND expiresAt > :now',
        ExpressionAttributeNames: { '#phase': 'phase' },
        ExpressionAttributeValues: {
          ':new': { S: 'NEW' }, ':exchanged': { S: 'EXCHANGED' }, ':now': { N: String(this.now()) },
        },
        ReturnValues: 'ALL_NEW',
      }) as { Attributes?: DynamoItem };
      const ticket = ticketFromItem(response.Attributes, ticketKey(tokenHash));
      if (!ticket || ticket.phase !== 'EXCHANGED' || ticket.expiresAt <= this.now()) throw new IntercomLoginStoreError();
      const { phase: _phase, ...binding } = ticket;
      return binding;
    } catch (error) {
      if (error instanceof ConditionalCheckFailed) return null;
      throw error;
    }
  }

  /** Claims the one allowed provider-completion attempt. COMPLETING is never retried. */
  async finish(tokenHash: string): Promise<boolean> {
    validateTokenHash(tokenHash);
    try {
      await this.call('UpdateItem', {
        TableName: this.tableName,
        Key: { pk: { S: ticketKey(tokenHash) } },
        UpdateExpression: 'SET #phase = :completing',
        ConditionExpression: '#phase = :exchanged AND expiresAt > :now',
        ExpressionAttributeNames: { '#phase': 'phase' },
        ExpressionAttributeValues: {
          ':exchanged': { S: 'EXCHANGED' }, ':completing': { S: 'COMPLETING' }, ':now': { N: String(this.now()) },
        },
      });
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailed) return false;
      throw error;
    }
  }

  /** Records the terminal result only for the claimed attempt; no state can be completed twice. */
  async complete(tokenHash: string, outcome: IntercomLoginOutcome): Promise<boolean> {
    validateTokenHash(tokenHash);
    if (outcome !== 'SAVED' && outcome !== 'FAILED') throw new IntercomLoginStoreError('intercom_login_ticket_invalid');
    try {
      await this.call('UpdateItem', {
        TableName: this.tableName,
        Key: { pk: { S: ticketKey(tokenHash) } },
        UpdateExpression: 'SET #phase = :outcome',
        ConditionExpression: '#phase = :completing',
        ExpressionAttributeNames: { '#phase': 'phase' },
        ExpressionAttributeValues: { ':completing': { S: 'COMPLETING' }, ':outcome': { S: outcome } },
      });
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailed) return false;
      throw error;
    }
  }

  async load(tokenHash: string): Promise<IntercomLoginTicket | null> {
    validateTokenHash(tokenHash);
    const response = await this.call('GetItem', {
      TableName: this.tableName,
      Key: { pk: { S: ticketKey(tokenHash) } },
      ConsistentRead: true,
    }) as { Item?: DynamoItem };
    const ticket = ticketFromItem(response.Item, ticketKey(tokenHash));
    if (!ticket || ticket.expiresAt <= this.now()) return null;
    return ticket;
  }
}
