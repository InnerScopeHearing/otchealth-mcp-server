import { createHash, randomUUID } from 'node:crypto';
import { canonicalUri, signRequest, resolveAwsCredentials } from "../../search/sigv4.js";
import type { BrowserCaptureMetadata, BrowserCaptureRecord, CloudBrowserProfile, CloudBrowserSession, CloudBrowserStore } from "./contract.js";
import { CloudBrowserError } from "./contract.js";
import { CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS } from './service.js';

type DynamoAttribute = {
  S?: string;
  N?: string;
  BOOL?: boolean;
  NULL?: boolean;
  L?: DynamoAttribute[];
};
type DynamoItem = Record<string, DynamoAttribute>;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const captureKey = (owner: string, id: string) => `browser-cloud/captures/${owner}/${id}`;
function readCapture(item: DynamoItem | undefined): BrowserCaptureRecord | null {
  if (!item?.pk?.S?.startsWith('CAPTURE#') || !item.owner?.S || !item.sessionId?.S || !item.captureId?.S || !item.contentType?.S || !item.byteLength?.N || !item.sha256?.S || !item.storageKey?.S || !item.storageVersion?.S || !item.createdAt?.N) return null;
  if (item.ownerSubjectHash !== undefined && (typeof item.ownerSubjectHash.S !== 'string' || !/^[a-f0-9]{64}$/i.test(item.ownerSubjectHash.S))) return null;
  const value = { id: item.captureId.S, owner: item.owner.S, sessionId: item.sessionId.S, contentType: item.contentType.S, byteLength: Number(item.byteLength.N), sha256: item.sha256.S, storageKey: item.storageKey.S, storageVersion: item.storageVersion.S, createdAt: Number(item.createdAt.N), ...(item.ownerSubjectHash?.S ? { ownerSubjectHash: item.ownerSubjectHash.S } : {}), ...(item.pageCount?.N ? { pageCount: Number(item.pageCount.N) } : {}) };
  if (!/^bca_[0-9a-f-]{36}$/.test(value.id) || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(value.owner) || (value.ownerSubjectHash !== undefined && !/^[a-f0-9]{64}$/i.test(value.ownerSubjectHash)) || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > MAX_CAPTURE_BYTES || !Number.isSafeInteger(value.createdAt) || !['application/pdf', 'image/png', 'image/jpeg'].includes(value.contentType) || (value.pageCount !== undefined && (!Number.isSafeInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 100)) || value.storageKey !== captureKey(value.owner, value.id) || !value.storageVersion || value.storageVersion === 'null') return null;
  return value as BrowserCaptureRecord;
}

function validTargets(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 21 && new Set(value).size === value.length && value.every((id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(id));
}

function lifecycleStateItem(session: CloudBrowserSession): DynamoItem {
  const leaseOwner = session.loginLeaseOwner;
  if (leaseOwner !== undefined && (typeof leaseOwner !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(leaseOwner) || !/^[a-f0-9]{64}$/i.test(session.ownerSubjectHash ?? ''))) throw new CloudBrowserError('session_state_invalid', 'Browser session lifecycle state is invalid.');
  if (session.providerStopToken !== undefined && (!leaseOwner || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(session.providerStopToken))) throw new CloudBrowserError('session_state_invalid', 'Browser session lifecycle state is invalid.');
  if (session.providerStopped !== undefined && (typeof session.providerStopped !== 'boolean' || !leaseOwner || !session.providerStopToken)) throw new CloudBrowserError('session_state_invalid', 'Browser session lifecycle state is invalid.');
  return {
    ...(leaseOwner === undefined ? {} : { loginLeaseOwner: { S: leaseOwner } }),
    ...(session.providerStopToken === undefined ? {} : { providerStopToken: { S: session.providerStopToken } }),
    ...(session.providerStopped === undefined ? {} : { providerStopped: { BOOL: session.providerStopped } }),
  };
}

function sessionTtl(session: CloudBrowserSession): string {
  // Recovery metadata must outlast the login lease's grace; this does not extend browser access.
  const cleanupUntil = session.expiresAt + (session.loginLeaseOwner === undefined ? 0 : 30_000);
  if (!Number.isSafeInteger(cleanupUntil)) throw new CloudBrowserError('session_state_invalid', 'Browser session expiry is invalid.');
  return String(Math.ceil(cleanupUntil / 1_000));
}

function pageStateItem(session: CloudBrowserSession): DynamoItem {
  if (session.ownedTargetIds === undefined) {
    if (session.selectedTargetId !== undefined) throw new CloudBrowserError("session_state_invalid", "Browser tab state is invalid.");
    return { ...(session.effectUnknown === undefined ? {} : { effectUnknown: { BOOL: session.effectUnknown } }), ...(session.sensitiveOutputSuppressed === undefined ? {} : { sensitiveOutputSuppressed: { BOOL: session.sensitiveOutputSuppressed } }) };
  }
  if (!validTargets(session.ownedTargetIds) || (session.selectedTargetId !== null && !session.ownedTargetIds.includes(session.selectedTargetId ?? ""))) {
    throw new CloudBrowserError("session_state_invalid", "Browser tab state is invalid.");
  }
  return {
    ownedTargetIds: { L: session.ownedTargetIds.map((id) => ({ S: id })) },
    selectedTargetId: session.selectedTargetId === null ? { NULL: true } : { S: session.selectedTargetId },
    ...(session.effectUnknown === undefined ? {} : { effectUnknown: { BOOL: session.effectUnknown } }),
    ...(session.sensitiveOutputSuppressed === undefined ? {} : { sensitiveOutputSuppressed: { BOOL: session.sensitiveOutputSuppressed } }),
  };
}

function profileItem(profile: CloudBrowserProfile): DynamoItem {
  if (profile.ownerSubjectHash !== undefined && !/^[a-f0-9]{64}$/i.test(profile.ownerSubjectHash)) throw new CloudBrowserError('profile_state_invalid', 'Browser profile state is invalid.');
  return {
    pk: { S: `PROFILE#${profile.profileId}` },
    owner: { S: profile.owner },
    ...(profile.ownerSubjectHash ? { ownerSubjectHash: { S: profile.ownerSubjectHash.toLowerCase() } } : {}),
    ...(profile.providerProfileId ? { providerProfileId: { S: profile.providerProfileId } } : {}),
    hosts: { L: profile.allowedHosts.map((host) => ({ S: host })) },
    persistent: { BOOL: profile.persistent },
    ...(profile.mode ? { mode: { S: profile.mode } } : {}),
    ...(profile.customBrowserIdentifier ? { customBrowserIdentifier: { S: profile.customBrowserIdentifier } } : {}),
    ...(profile.networkPolicyVersion ? { networkPolicyVersion: { S: profile.networkPolicyVersion } } : {}),
    ...(profile.privateHostPolicy ? { privateHostPolicy: { S: profile.privateHostPolicy } } : {}),
    ...(profile.proxyConfiguration
      ? {
          proxyConfiguration: { S: JSON.stringify(profile.proxyConfiguration) },
        }
      : {}),
    ...(profile.actionBudget ? { actionBudget: { N: String(profile.actionBudget) } } : {}),
    ...(profile.maxSessionSeconds ? { maxSessionSeconds: { N: String(profile.maxSessionSeconds) } } : {}),
    ...(profile.maxActionSeconds ? { maxActionSeconds: { N: String(profile.maxActionSeconds) } } : {}),
  };
}
function readProfile(item: DynamoItem | undefined): CloudBrowserProfile | null {
  if (!item?.pk?.S?.startsWith("PROFILE#") || !item.owner?.S || !item.hosts?.L) return null;
  if (item.ownerSubjectHash !== undefined && (typeof item.ownerSubjectHash.S !== 'string' || !/^[a-f0-9]{64}$/i.test(item.ownerSubjectHash.S))) return null;
  const allowedHosts = item.hosts.L.map((x) => x.S).filter((x): x is string => typeof x === "string");
  const proxyConfiguration = item.proxyConfiguration?.S ? (JSON.parse(item.proxyConfiguration.S) as CloudBrowserProfile["proxyConfiguration"]) : undefined;
  return {
    profileId: item.pk.S.slice(8),
    owner: item.owner.S,
    ...(item.ownerSubjectHash?.S ? { ownerSubjectHash: item.ownerSubjectHash.S.toLowerCase() } : {}),
    ...(item.providerProfileId?.S ? { providerProfileId: item.providerProfileId.S } : {}),
    allowedHosts,
    persistent: item.persistent?.BOOL === true,
    ...(item.mode?.S === "public_web" || item.mode?.S === "enrolled_hosts" ? { mode: item.mode.S } : {}),
    ...(item.customBrowserIdentifier?.S ? { customBrowserIdentifier: item.customBrowserIdentifier.S } : {}),
    ...(item.networkPolicyVersion?.S ? { networkPolicyVersion: item.networkPolicyVersion.S } : {}),
    ...(item.privateHostPolicy?.S ? { privateHostPolicy: item.privateHostPolicy.S } : {}),
    ...(proxyConfiguration ? { proxyConfiguration } : {}),
    ...(item.actionBudget?.N ? { actionBudget: Number(item.actionBudget.N) } : {}),
    ...(item.maxSessionSeconds?.N ? { maxSessionSeconds: Number(item.maxSessionSeconds.N) } : {}),
    ...(item.maxActionSeconds?.N ? { maxActionSeconds: Number(item.maxActionSeconds.N) } : {}),
  };
}
function sessionItem(session: CloudBrowserSession): DynamoItem {
  if (session.ownerSubjectHash !== undefined && !/^[a-f0-9]{64}$/i.test(session.ownerSubjectHash)) throw new CloudBrowserError('session_state_invalid', 'Browser session state is invalid.');
  return {
    pk: { S: `SESSION#${session.sessionId}` },
    owner: { S: session.owner },
    ...(session.ownerSubjectHash ? { ownerSubjectHash: { S: session.ownerSubjectHash.toLowerCase() } } : {}),
    profileId: { S: session.profileId },
    hosts: { L: session.allowedHosts.map((host) => ({ S: host })) },
    expiresAt: { N: String(session.expiresAt) },
    expiresAtEpoch: { N: sessionTtl(session) },
    actionsUsed: { N: String(session.actionsUsed) },
    providerSessionId: { S: session.providerSessionId },
    automationEndpoint: { S: session.automationEndpoint },
    ...(session.providerBrowserId ? { providerBrowserId: { S: session.providerBrowserId } } : {}),
    ...(session.mode ? { mode: { S: session.mode } } : {}),
    ...(session.actionBudget ? { actionBudget: { N: String(session.actionBudget) } } : {}),
    ...lifecycleStateItem(session),
    ...pageStateItem(session),
  };
}
function readSession(item: DynamoItem | undefined): CloudBrowserSession | null {
  if (!item?.pk?.S?.startsWith("SESSION#") || !item.owner?.S || !item.profileId?.S || !item.hosts?.L || !item.expiresAt?.N || !item.actionsUsed?.N || !item.providerSessionId?.S || !item.automationEndpoint?.S) return null;
  if (item.ownerSubjectHash !== undefined && (typeof item.ownerSubjectHash.S !== 'string' || !/^[a-f0-9]{64}$/i.test(item.ownerSubjectHash.S))) return null;
  const expiresAt = Number(item.expiresAt.N);
  const actionsUsed = Number(item.actionsUsed.N);
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(actionsUsed)) return null;
  const pageState: Pick<CloudBrowserSession, "ownedTargetIds" | "selectedTargetId" | "effectUnknown" | "sensitiveOutputSuppressed"> = {};
  if (item.ownedTargetIds !== undefined || item.selectedTargetId !== undefined) {
    if (!Array.isArray(item.ownedTargetIds?.L)) return null;
    const targets = item.ownedTargetIds.L.map((value) => value?.S);
    if (!validTargets(targets)) return null;
    const selected = item.selectedTargetId?.NULL === true ? null : item.selectedTargetId?.S;
    if (selected !== null && (typeof selected !== "string" || !targets.includes(selected))) return null;
    pageState.ownedTargetIds = targets;
    pageState.selectedTargetId = selected;
  }
  if (item.effectUnknown !== undefined) {
    if (typeof item.effectUnknown.BOOL !== "boolean") return null;
    pageState.effectUnknown = item.effectUnknown.BOOL;
  }
  if (item.sensitiveOutputSuppressed !== undefined) {
    if (typeof item.sensitiveOutputSuppressed.BOOL !== 'boolean') return null;
    pageState.sensitiveOutputSuppressed = item.sensitiveOutputSuppressed.BOOL;
  }
  if (item.loginLeaseOwner !== undefined && typeof item.loginLeaseOwner.S !== 'string') return null;
  if (item.providerStopToken !== undefined && typeof item.providerStopToken.S !== 'string') return null;
  if (item.providerStopped !== undefined && typeof item.providerStopped.BOOL !== 'boolean') return null;
  const session: CloudBrowserSession = {
    sessionId: item.pk.S.slice(8),
    owner: item.owner.S,
    ...(item.ownerSubjectHash?.S ? { ownerSubjectHash: item.ownerSubjectHash.S.toLowerCase() } : {}),
    profileId: item.profileId.S,
    allowedHosts: item.hosts.L.map((x) => x.S).filter((x): x is string => typeof x === "string"),
    expiresAt,
    actionsUsed,
    providerSessionId: item.providerSessionId.S,
    automationEndpoint: item.automationEndpoint.S,
    ...(item.providerBrowserId?.S ? { providerBrowserId: item.providerBrowserId.S } : {}),
    ...(item.mode?.S === "public_web" || item.mode?.S === "enrolled_hosts" ? { mode: item.mode.S } : {}),
    ...(item.actionBudget?.N ? { actionBudget: Number(item.actionBudget.N) } : {}),
    ...(item.loginLeaseOwner?.S === undefined ? {} : { loginLeaseOwner: item.loginLeaseOwner.S }),
    ...(item.providerStopToken?.S === undefined ? {} : { providerStopToken: item.providerStopToken.S }),
    ...(item.providerStopped?.BOOL === undefined ? {} : { providerStopped: item.providerStopped.BOOL }),
    ...pageState,
  };
  try { lifecycleStateItem(session); } catch { return null; }
  return session;
}

/**
 * Dynamo persistence shared by all gateway copies. The provisioned table uses `pk` as its key and
 * `expiresAtEpoch` as TTL. The only opaque provider references are encrypted at rest by Dynamo.
 */
export class DynamoCloudBrowserSessionStore implements CloudBrowserStore {
  async verifyLoginLease(profileId: string, leaseOwner?: string): Promise<boolean> {
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/i.test(profileId) ||
      (leaseOwner !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(leaseOwner))) return false;
    const pk = `WEBSITE_LOGIN_LEASE#${profileId}`;
    const response = await this.call('GetItem', {
      TableName: this.tableName, Key: { pk: { S: pk } }, ConsistentRead: true,
    }) as { Item?: DynamoItem };
    if (response.Item === undefined) return true;
    const item = response.Item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (item.pk?.S !== pk) return false;
    const lockOwner = item.lockOwner?.S;
    const lockUntil = Number(item.lockUntil?.N);
    if (typeof lockOwner !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(lockOwner) ||
      !Number.isSafeInteger(lockUntil) || lockUntil <= 0) return false;
    return lockUntil < this.now() || leaseOwner === lockOwner;
  }
  async createProfileIntent(profile: CloudBrowserProfile): Promise<boolean> {
    if (profile.providerProfileId || !(CLOUD_BROWSER_PUBLIC_TRIAL_OWNERS as readonly string[]).includes(profile.owner) || !/^[a-f0-9]{64}$/.test(profile.ownerSubjectHash || '')) throw new CloudBrowserError('profile_intent_invalid','Profile preparation is invalid.');
    try {
      await this.call('PutItem',{ TableName:this.tableName, Item:profileItem(profile), ConditionExpression:'attribute_not_exists(pk)' });
      return true;
    } catch (error) {
      if (error instanceof CloudBrowserError && error.code === 'session_store_conflict') return false;
      throw error;
    }
  }
  constructor(
    private readonly tableName = process.env.CLOUD_BROWSER_DDB_TABLE || "otchealth-browser-cloud",
    private readonly region = process.env.AWS_REGION || "us-east-1",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  private async call(target: string, payload: unknown): Promise<unknown> {
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError("aws_credentials_unavailable", "Cloud browser runtime credentials are unavailable.");
    const host = `dynamodb.${this.region}.amazonaws.com`;
    const body = JSON.stringify(payload);
    const signed = signRequest({
      method: "POST",
      host,
      path: "/",
      body,
      region: this.region,
      service: "dynamodb",
      credentials,
      extraHeaders: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `DynamoDB_20120810.${target}`,
      },
    });
    const response = await this.fetchImpl(`https://${host}/`, {
      method: "POST",
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { __type?: unknown };
      if (typeof error.__type === 'string' && error.__type.endsWith('ConditionalCheckFailedException')) throw new CloudBrowserError('session_store_conflict','Cloud browser state changed concurrently.');
      throw new CloudBrowserError("session_store_failed", "Cloud browser session store rejected the request.");
    }
    return response.json();
  }
  async loadProfile(profileId: string): Promise<CloudBrowserProfile | null> {
    const r = (await this.call("GetItem", {
      TableName: this.tableName,
      Key: { pk: { S: `PROFILE#${profileId}` } },
      ConsistentRead: true,
    })) as { Item?: DynamoItem };
    return readProfile(r.Item);
  }
  async saveProfile(profile: CloudBrowserProfile): Promise<void> {
    await this.call("PutItem", {
      TableName: this.tableName,
      Item: profileItem(profile),
      // PutItem replaces the whole item, so same-owner rewrites must not erase a live profile lease.
      ConditionExpression: "attribute_not_exists(pk) OR (#owner = :owner AND (attribute_not_exists(lockUntil) OR lockUntil < :now))",
      ExpressionAttributeNames: { "#owner": "owner" },
      ExpressionAttributeValues: { ":owner": { S: profile.owner }, ":now": { N: String(this.now()) } },
    });
  }
  async loadSession(sessionId: string): Promise<CloudBrowserSession | null> {
    const r = (await this.call("GetItem", {
      TableName: this.tableName,
      Key: { pk: { S: `SESSION#${sessionId}` } },
      ConsistentRead: true,
    })) as { Item?: DynamoItem };
    return readSession(r.Item);
  }
  async saveSession(session: CloudBrowserSession): Promise<void> {
    await this.call("PutItem", {
      TableName: this.tableName,
      Item: sessionItem(session),
    });
  }
  async saveSessionUnderLock(session: CloudBrowserSession, lockOwner: string): Promise<void> {
    let endpoint: URL;
    try { endpoint = new URL(session.automationEndpoint); } catch { throw new CloudBrowserError('session_state_invalid', 'Browser session endpoint is invalid.'); }
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new CloudBrowserError('session_state_invalid', 'Browser session endpoint is invalid.');
    const state = { ...pageStateItem(session), ...lifecycleStateItem(session) };
    const values: Record<string, DynamoAttribute> = {
      ":actions": { N: String(session.actionsUsed) },
      ":expires": { N: String(session.expiresAt) },
      ":ttl": { N: sessionTtl(session) },
      ":owner": { S: lockOwner },
      ":automationEndpoint": { S: session.automationEndpoint },
    };
    const assignments = ["actionsUsed = :actions", "expiresAt = :expires", "expiresAtEpoch = :ttl", "automationEndpoint = :automationEndpoint"];
    for (const [attribute, variable] of [
      ["ownedTargetIds", ":targets"],
      ["selectedTargetId", ":selected"],
      ["effectUnknown", ":uncertain"],
      ["sensitiveOutputSuppressed", ":sensitive"],
      ["loginLeaseOwner", ":loginLeaseOwner"],
      ["providerStopToken", ":providerStopToken"],
      ["providerStopped", ":providerStopped"],
    ] as const) {
      if (state[attribute] !== undefined) {
        assignments.push(`${attribute} = ${variable}`);
        values[variable] = state[attribute];
      }
    }
    await this.call("UpdateItem", {
      TableName: this.tableName,
      Key: { pk: { S: `SESSION#${session.sessionId}` } },
      UpdateExpression: `SET ${assignments.join(", ")}`,
      ConditionExpression: "lockOwner = :owner",
      ExpressionAttributeValues: values,
    });
  }
  async deleteSession(sessionId: string): Promise<void> {
    await this.call("DeleteItem", {
      TableName: this.tableName,
      Key: { pk: { S: `SESSION#${sessionId}` } },
    });
  }
  /** Only a confirmed-stopped, exact locked SESSION can authorize release of its opaque login lease. */
  async releaseStoppedLoginLease(session: CloudBrowserSession, lockOwner: string): Promise<void> {
    lifecycleStateItem(session);
    if (!session.loginLeaseOwner || !session.providerStopped || !session.providerStopToken || !session.ownerSubjectHash) throw new CloudBrowserError('login_lease_cleanup_invalid', 'The stopped login session could not be confirmed.');
    const response = await this.call('GetItem', {
      TableName: this.tableName, Key: { pk: { S: `SESSION#${session.sessionId}` } }, ConsistentRead: true,
    }) as { Item?: DynamoItem };
    const current = readSession(response.Item);
    if (!current || response.Item?.lockOwner?.S !== lockOwner || current.sessionId !== session.sessionId || current.owner !== session.owner
      || current.ownerSubjectHash !== session.ownerSubjectHash.toLowerCase() || current.profileId !== session.profileId
      || current.providerSessionId !== session.providerSessionId || current.providerBrowserId !== session.providerBrowserId
      || current.loginLeaseOwner !== session.loginLeaseOwner || current.providerStopToken !== session.providerStopToken || !current.providerStopped) {
      throw new CloudBrowserError('login_lease_cleanup_invalid', 'The stopped login session could not be confirmed.');
    }
    try {
      await this.call('DeleteItem', {
        TableName: this.tableName, Key: { pk: { S: `WEBSITE_LOGIN_LEASE#${session.profileId}` } },
        ConditionExpression: 'lockOwner = :leaseOwner', ExpressionAttributeValues: { ':leaseOwner': { S: session.loginLeaseOwner } },
      });
    } catch (error) {
      // An absent or replaced lease no longer belongs to this session; never delete a newer owner.
      if (!(error instanceof CloudBrowserError && error.code === 'session_store_conflict')) throw error;
    }
  }
  /** Atomically claim a known expired session only while its owner and expiry still match. */
  async claimExpiredSessionCleanup(sessionId: string, owner: string, now: number, lockOwner: string, until: number): Promise<boolean> {
    try {
      await this.call("UpdateItem", {
        TableName: this.tableName,
        Key: { pk: { S: `SESSION#${sessionId}` } },
        UpdateExpression: "SET lockOwner = :lockOwner, lockUntil = :until",
        ConditionExpression: "attribute_exists(pk) AND #owner = :owner AND expiresAt <= :now AND (attribute_not_exists(lockUntil) OR lockUntil < :now)",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: {
          ":owner": { S: owner }, ":now": { N: String(now) },
          ":lockOwner": { S: lockOwner }, ":until": { N: String(until) },
        },
      });
      return true;
    } catch { return false; }
  }
  /** Delete only the exact expired session still fenced by this cleanup lease. */
  async deleteExpiredSessionUnderLock(sessionId: string, owner: string, lockOwner: string, now: number): Promise<boolean> {
    try {
      await this.call("DeleteItem", {
        TableName: this.tableName,
        Key: { pk: { S: `SESSION#${sessionId}` } },
        ConditionExpression: "#owner = :owner AND lockOwner = :lockOwner AND expiresAt <= :now",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: {
          ":owner": { S: owner }, ":lockOwner": { S: lockOwner }, ":now": { N: String(now) },
        },
      });
      return true;
    } catch { return false; }
  }
  async acquireSessionLock(sessionId: string, owner: string, until: number): Promise<boolean> {
    try {
      await this.call("UpdateItem", {
        TableName: this.tableName,
        Key: { pk: { S: `SESSION#${sessionId}` } },
        UpdateExpression: "SET lockOwner = :owner, lockUntil = :until",
        ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)",
        ExpressionAttributeValues: {
          ":owner": { S: owner },
          ":until": { N: String(until) },
          ":now": { N: String(Date.now()) },
        },
      });
      return true;
    } catch {
      return false;
    }
  }
  async releaseSessionLock(sessionId: string, owner: string): Promise<void> {
    try {
      await this.call("UpdateItem", {
        TableName: this.tableName,
        Key: { pk: { S: `SESSION#${sessionId}` } },
        UpdateExpression: "REMOVE lockOwner, lockUntil",
        ConditionExpression: "lockOwner = :owner",
        ExpressionAttributeValues: { ":owner": { S: owner } },
      });
    } catch {
      /* lease expiry safely recovers a failed owner */
    }
  }
  async acquireProfileLock(profileId: string, owner: string, until: number): Promise<boolean> {
    try {
      await this.call("UpdateItem", {
        TableName: this.tableName,
        Key: { pk: { S: `PROFILE#${profileId}` } },
        UpdateExpression: "SET lockOwner = :owner, lockUntil = :until",
        ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(lockUntil) OR lockUntil < :now)",
        ExpressionAttributeValues: {
          ":owner": { S: owner },
          ":until": { N: String(until) },
          ":now": { N: String(Date.now()) },
        },
      });
      return true;
    } catch {
      return false;
    }
  }
  async releaseProfileLock(profileId: string, owner: string): Promise<void> {
    try {
      await this.call("UpdateItem", {
        TableName: this.tableName,
        Key: { pk: { S: `PROFILE#${profileId}` } },
        UpdateExpression: "REMOVE lockOwner, lockUntil",
        ConditionExpression: "lockOwner = :owner",
        ExpressionAttributeValues: { ":owner": { S: owner } },
      });
    } catch {
      /* lease expiry safely recovers a failed owner */
    }
  }
  async reserveDailySession(owner: string, day: string, limit: number): Promise<boolean> {
    try {
      await this.call("UpdateItem", {
        TableName: this.tableName,
        Key: { pk: { S: `BUDGET#${day}#${owner}` } },
        UpdateExpression: "ADD sessionCount :one SET expiresAtEpoch = :ttl",
        ConditionExpression: "attribute_not_exists(sessionCount) OR sessionCount < :limit",
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":limit": { N: String(limit) },
          ":ttl": {
            N: String(Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1_000) + 2 * 86_400),
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async createCapture(owner: string, sessionId: string, artifact: import('./captures.js').BrowserCapturedArtifact, createdAt: number, ownerSubjectHash?: string): Promise<BrowserCaptureMetadata> {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(owner) || !/^[0-9a-f-]{36}$/i.test(sessionId) || (ownerSubjectHash !== undefined && !/^[a-f0-9]{64}$/i.test(ownerSubjectHash)) || !Number.isSafeInteger(createdAt) || createdAt < 0 || artifact.body.byteLength < 1 || artifact.body.byteLength > MAX_CAPTURE_BYTES) throw new CloudBrowserError('capture_storage_failed', 'The browser capture could not be stored safely.');
    const id = `bca_${randomUUID()}`;
    const key = captureKey(owner, id);
    const sha256 = createHash('sha256').update(artifact.body).digest('hex');
    if (sha256 !== artifact.sha256) throw new CloudBrowserError('capture_storage_failed', 'The browser capture could not be stored safely.');
    const bucket = process.env.CLOUD_BROWSER_ARTIFACT_BUCKET;
    if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new CloudBrowserError('capture_storage_unavailable', 'Browser capture storage is unavailable.');
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError('capture_storage_unavailable', 'Browser capture storage is unavailable.');
    const host = `${bucket}.s3.${this.region}.amazonaws.com`;
    const payload = Buffer.from(artifact.body);
    const signed = signRequest({ method: 'PUT', host, path: `/${key}`, region: this.region, service: 's3', credentials, body: payload, extraHeaders: { 'content-type': artifact.contentType, 'if-none-match': '*', 'x-amz-server-side-encryption': 'AES256', 'x-amz-meta-sha256': sha256, 'x-amz-content-sha256': sha256 } });
    let version: string | null;
    try {
      const response = await this.fetchImpl(`https://${host}${canonicalUri(`/${key}`)}`, { method: 'PUT', headers: signed.headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('s3');
      version = response.headers.get('x-amz-version-id');
    } catch { throw new CloudBrowserError('capture_storage_failed', 'The browser capture could not be stored safely.'); }
    if (!version || version === 'null') throw new CloudBrowserError('capture_storage_failed', 'Immutable browser capture versioning is unavailable.');
    const metadata: BrowserCaptureRecord = { id, owner, sessionId, contentType: artifact.contentType, byteLength: payload.byteLength, sha256, createdAt, storageKey: key, storageVersion: version, ...(ownerSubjectHash === undefined ? {} : { ownerSubjectHash: ownerSubjectHash.toLowerCase() }), ...(artifact.pageCount === undefined ? {} : { pageCount: artifact.pageCount }) };
    try {
      await this.call('PutItem', { TableName: this.tableName, Item: {
        pk: { S: `CAPTURE#${id}` }, captureId: { S: id }, owner: { S: owner }, sessionId: { S: sessionId }, contentType: { S: metadata.contentType }, byteLength: { N: String(metadata.byteLength) }, sha256: { S: sha256 }, storageKey: { S: key }, storageVersion: { S: version }, createdAt: { N: String(createdAt) }, ...(metadata.ownerSubjectHash === undefined ? {} : { ownerSubjectHash: { S: metadata.ownerSubjectHash } }), ...(metadata.pageCount === undefined ? {} : { pageCount: { N: String(metadata.pageCount) } }), expiresAtEpoch: { N: String(Math.floor(createdAt / 1_000) + 30 * 86_400) },
      }, ConditionExpression: 'attribute_not_exists(pk)' });
    } catch { throw new CloudBrowserError('capture_storage_failed', 'The browser capture could not be stored safely.'); }
    const { storageKey: _key, storageVersion: _version, ...publicMetadata } = metadata;
    return publicMetadata;
  }

  async loadCapture(owner: string, captureId: string, principalHash?: string): Promise<{ metadata: BrowserCaptureMetadata; body: Uint8Array } | null> {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(owner) || !/^bca_[0-9a-f-]{36}$/.test(captureId)) return null;
    const response = await this.call('GetItem', { TableName: this.tableName, Key: { pk: { S: `CAPTURE#${captureId}` } }, ConsistentRead: true }) as { Item?: DynamoItem };
    const expiresAtEpoch = Number(response.Item?.expiresAtEpoch?.N);
    if (!Number.isSafeInteger(expiresAtEpoch) || expiresAtEpoch <= Math.floor(this.now() / 1_000)) return null;
    const metadata = readCapture(response.Item);
    if (!metadata || metadata.id !== captureId || metadata.owner !== owner) return null;
    if (metadata.ownerSubjectHash !== undefined && (!principalHash || !/^[a-f0-9]{64}$/i.test(principalHash) || metadata.ownerSubjectHash.toLowerCase() !== principalHash.toLowerCase())) return null;
    const bucket = process.env.CLOUD_BROWSER_ARTIFACT_BUCKET;
    if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new CloudBrowserError('capture_storage_unavailable', 'Browser capture storage is unavailable.');
    const credentials = await resolveAwsCredentials();
    if (!credentials) throw new CloudBrowserError('capture_storage_unavailable', 'Browser capture storage is unavailable.');
    const host = `${bucket}.s3.${this.region}.amazonaws.com`;
    const signed = signRequest({ method: 'GET', host, path: `/${metadata.storageKey}`, query: { versionId: metadata.storageVersion }, region: this.region, service: 's3', credentials, extraHeaders: { 'x-amz-content-sha256': createHash('sha256').update(new Uint8Array()).digest('hex') } });
    try {
      const response = await this.fetchImpl(`https://${host}${canonicalUri(`/${metadata.storageKey}`)}?versionId=${encodeURIComponent(metadata.storageVersion)}`, { method: 'GET', headers: signed.headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (!response.ok || response.headers.get('x-amz-version-id') !== metadata.storageVersion || response.headers.get('content-type')?.split(';')[0]?.trim() !== metadata.contentType || declared !== metadata.byteLength || declared > MAX_CAPTURE_BYTES) throw new Error('s3');
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength !== declared || createHash('sha256').update(body).digest('hex') !== metadata.sha256) throw new Error('integrity');
      return { metadata, body };
    } catch { throw new CloudBrowserError('capture_integrity_failed', 'Browser capture integrity could not be verified.'); }
  }
}
