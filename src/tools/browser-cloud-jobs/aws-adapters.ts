/** AWS-native ports for cloud browser jobs. They use ECS task-role SigV4 credentials and never persist locally. */
import { createHash } from 'node:crypto';
import { canonicalUri, resolveAwsCredentials, signRequest, type AwsCredentials, type SignedRequest } from '../../search/sigv4.js';
import type { BrowserJob, CloudBrowserArtifactStore, CloudBrowserJobStore, CloudBrowserWorkerQueue } from './contracts.js';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_TABLE = 'otchealth-browser-cloud';
const DEFAULT_BUCKET = 'otchealth-chat-agents-900915535335-us-east-1';
const PREFIX = 'browser-cloud/';
type Fetch = typeof globalThis.fetch;
type Signer = (input: Parameters<typeof signRequest>[0]) => SignedRequest;

export interface AwsBrowserJobsConfig { region?: string; table?: string; bucket?: string; queueUrl?: string; }
export interface AwsBrowserJobsDeps { credentials?: () => Promise<AwsCredentials | null>; sign?: Signer; fetch?: Fetch; }
const attrs = (value: unknown): { S: string } => ({ S: JSON.stringify(value) });
const text = (value: string): { S: string } => ({ S: value });
const decode = (value: { S?: string } | undefined): string | null => typeof value?.S === 'string' ? value.S : null;
const key = (job: BrowserJob) => `JOB#${job.id}`;
const idemKey = (agent: string, digest: string) => `IDEM#${agent}#${digest}`;

function checked(config: AwsBrowserJobsConfig): Required<AwsBrowserJobsConfig> {
  const out = { region: config.region ?? DEFAULT_REGION, table: config.table ?? DEFAULT_TABLE, bucket: config.bucket ?? DEFAULT_BUCKET, queueUrl: config.queueUrl ?? '' };
  if (!/^[a-z0-9-]{3,255}$/.test(out.table) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(out.bucket) || !/^[a-z]{2}-[a-z]+-\d$/.test(out.region)) throw new Error('browser_cloud_aws_config_invalid');
  return out;
}
function noCredentials(): never { throw new Error('browser_cloud_aws_credentials_unavailable'); }

function ddb(config: Required<AwsBrowserJobsConfig>, deps: AwsBrowserJobsDeps) {
  const credentials = deps.credentials ?? resolveAwsCredentials; const signer = deps.sign ?? signRequest; const fetcher = deps.fetch ?? fetch;
  return async (target: string, payload: unknown): Promise<Record<string, unknown>> => {
    const creds = await credentials(); if (!creds) noCredentials(); const body = JSON.stringify(payload); const host = `dynamodb.${config.region}.amazonaws.com`;
    const signed = signer({ method: 'POST', host, path: '/', region: config.region, service: 'dynamodb', credentials: creds, body, extraHeaders: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` } });
    const response = await fetcher(`https://${host}/`, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const responseText = await response.text(); if (responseText.length > 1_000_000) throw new Error('browser_cloud_ddb_response_too_large');
    if (!response.ok) { let kind = ''; let conditionalOnly = false; try { const parsed = JSON.parse(responseText) as { __type?: unknown; CancellationReasons?: Array<{ Code?: unknown }> }; kind = String(parsed.__type ?? ''); const reasons = parsed.CancellationReasons; conditionalOnly = kind.includes('TransactionCanceledException') && Array.isArray(reasons) && reasons.some(reason => reason.Code === 'ConditionalCheckFailed') && reasons.every(reason => reason.Code === undefined || reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed'); } catch {} throw new Error(`browser_cloud_ddb_${response.status}_${kind}${conditionalOnly ? ':conditional' : ''}`); }
    return responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
  };
}

/** Dynamo layout: job item PK=JOB#id, idempotency item PK=IDEM#agent#sha. Provision TTL on expiresAtEpoch. */
export function createDynamoBrowserJobStore(configInput: AwsBrowserJobsConfig = {}, deps: AwsBrowserJobsDeps = {}): CloudBrowserJobStore {
  const config = checked(configInput); const request = ddb(config, deps);
  const read = async (pk: string): Promise<{ job: BrowserJob; version: string } | null> => {
    const result = await request('GetItem', { TableName: config.table, ConsistentRead: true, Key: { pk: text(pk) } });
    const item = result.Item as Record<string, { S?: string }> | undefined; const value = decode(item?.job); const version = decode(item?.version); return value && version ? { job: JSON.parse(value) as BrowserJob, version } : null;
  };
  return {
    async createIfAbsent(job) {
      const version = '1'; const jobItem = { pk: text(key(job)), job: attrs(job), version: text(version), expiresAtEpoch: { N: String(Math.floor(Date.parse(job.createdAt) / 1000) + 30 * 86400) } };
      const indexItem = { pk: text(idemKey(job.agent, job.idempotencyDigest)), job: attrs(job), version: text(version), expiresAtEpoch: { N: String(Math.floor(Date.parse(job.createdAt) / 1000) + 30 * 86400) } };
      try { await request('TransactWriteItems', { ReturnCancellationReasons: true, TransactItems: [{ Put: { TableName: config.table, Item: jobItem, ConditionExpression: 'attribute_not_exists(pk)' } }, { Put: { TableName: config.table, Item: indexItem, ConditionExpression: 'attribute_not_exists(pk)' } }] }); return 'created'; } catch (error) { if (String(error).includes(':conditional') || String(error).includes('ConditionalCheckFailedException')) return 'exists'; throw error; }
    },
    async readById(id) { const hit = await read(`JOB#${id}`); return hit && { value: hit.job, version: hit.version }; },
    async readByIdempotency(agent, digest) { const hit = await read(idemKey(agent, digest)); return hit && { value: hit.job, version: hit.version }; },
    async replace(job, expectedVersion) {
      const next = String(Number(expectedVersion) + 1); const update = (pk: string) => ({ Update: { TableName: config.table, Key: { pk: text(pk) }, ConditionExpression: '#v = :expected', UpdateExpression: 'SET job = :job, #v = :next', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':expected': text(expectedVersion), ':next': text(next), ':job': attrs(job) } } });
      try { await request('TransactWriteItems', { ReturnCancellationReasons: true, TransactItems: [update(key(job)), update(idemKey(job.agent, job.idempotencyDigest))] }); return 'replaced'; } catch (error) { if (String(error).includes('ConditionalCheckFailed')) return 'conflict'; throw error; }
    },
  };
}

export function createS3BrowserArtifactStore(configInput: AwsBrowserJobsConfig = {}, deps: AwsBrowserJobsDeps = {}): CloudBrowserArtifactStore {
  const config = checked(configInput); const credentials = deps.credentials ?? resolveAwsCredentials; const signer = deps.sign ?? signRequest; const fetcher = deps.fetch ?? fetch;
  return { async putImmutable(input) {
    if (!input.key.startsWith(PREFIX) || input.key.includes('..') || input.body.byteLength > 16 * 1024 * 1024) throw new Error('browser_cloud_artifact_key');
    const actual = createHash('sha256').update(input.body).digest('hex'); if (actual !== input.sha256) throw new Error('browser_cloud_artifact_digest');
    const creds = await credentials(); if (!creds) noCredentials(); const host = `${config.bucket}.s3.${config.region}.amazonaws.com`;
    const signed = signer({ method: 'PUT', host, path: `/${input.key}`, region: config.region, service: 's3', credentials: creds, body: Buffer.from(input.body), extraHeaders: { 'content-type': input.contentType, 'if-none-match': '*', 'x-amz-server-side-encryption': 'AES256', 'x-amz-meta-sha256': input.sha256 } });
    const response = await fetcher(`https://${host}${canonicalUri(`/${input.key}`)}`, { method: 'PUT', headers: signed.headers, body: Buffer.from(input.body), redirect: 'error', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`browser_cloud_s3_${response.status}`); const version = response.headers.get('x-amz-version-id'); if (!version || version === 'null') throw new Error('browser_cloud_s3_version_required'); return { version };
  }, async getVersion(input) {
    if (!input.key.startsWith(PREFIX) || input.key.includes('..') || !input.version || input.version === 'null' || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1_000_000) throw new Error('browser_cloud_artifact_read_invalid');
    const creds = await credentials(); if (!creds) noCredentials(); const host = `${config.bucket}.s3.${config.region}.amazonaws.com`; const signed = signer({ method: 'GET', host, path: `/${input.key}`, query: { versionId: input.version }, region: config.region, service: 's3', credentials: creds });
    const response = await fetcher(`https://${host}${canonicalUri(`/${input.key}`)}?versionId=${encodeURIComponent(input.version)}`, { method: 'GET', headers: signed.headers, redirect: 'error', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`browser_cloud_s3_${response.status}`); const declared = Number(response.headers.get('content-length') ?? '0'); if (!Number.isSafeInteger(declared) || declared < 0 || declared > input.maxBytes) throw new Error('browser_cloud_artifact_too_large'); const body = Buffer.from(await response.arrayBuffer()); if (body.byteLength > input.maxBytes || body.byteLength !== declared) throw new Error('browser_cloud_artifact_too_large'); const contentType = response.headers.get('content-type') ?? 'application/octet-stream'; if (!['application/json', 'text/plain'].some(type => contentType.toLowerCase().startsWith(type))) throw new Error('browser_cloud_artifact_content_type'); return { body, contentType };
  } };
}

export function createSqsBrowserQueue(configInput: AwsBrowserJobsConfig, deps: AwsBrowserJobsDeps = {}): CloudBrowserWorkerQueue {
  const config = checked(configInput); if (!config.queueUrl.startsWith(`https://sqs.${config.region}.amazonaws.com/`)) throw new Error('browser_cloud_queue_url_required'); const credentials = deps.credentials ?? resolveAwsCredentials; const signer = deps.sign ?? signRequest; const fetcher = deps.fetch ?? fetch;
  const call = async (params: Record<string, string>): Promise<string> => { const creds = await credentials(); if (!creds) noCredentials(); const url = new URL(config.queueUrl); const body = new URLSearchParams({ Version: '2012-11-05', ...params }).toString(); const signed = signer({ method: 'POST', host: url.host, path: url.pathname, region: config.region, service: 'sqs', credentials: creds, body, extraHeaders: { 'content-type': 'application/x-www-form-urlencoded' } }); const response = await fetcher(url, { method: 'POST', headers: signed.headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`browser_cloud_sqs_${response.status}`); const value = await response.text(); if (value.length > 1_000_000) throw new Error('browser_cloud_sqs_response_too_large'); return value; };
  const fifo = config.queueUrl.endsWith('.fifo');
  return {
    async enqueue(jobId, agent) { await call({ Action: 'SendMessage', MessageBody: JSON.stringify({ jobId, agent }), ...(fifo ? { MessageGroupId: agent, MessageDeduplicationId: jobId } : {}) }); },
    async receive(maxMessages, visibilityTimeoutSeconds) { const xml = await call({ Action: 'ReceiveMessage', MaxNumberOfMessages: String(maxMessages), VisibilityTimeout: String(visibilityTimeoutSeconds), WaitTimeSeconds: '0' }); const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))); const blocks = [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map(m => m[1] ?? ''); return blocks.flatMap(block => { const field = (name: string) => { const value = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(block)?.[1]; return value ? decode(value) : undefined; }; const id = field('MessageId'); const receipt = field('ReceiptHandle'); const raw = field('Body'); if (!id || !receipt || !raw) return []; try { const parsed = JSON.parse(raw) as { jobId?: unknown; agent?: unknown }; return typeof parsed.jobId === 'string' && typeof parsed.agent === 'string' ? [{ id, receipt, jobId: parsed.jobId, agent: parsed.agent }] : []; } catch { return []; } }); },
    async delete(receipt) { await call({ Action: 'DeleteMessage', ReceiptHandle: receipt }); },
    async changeVisibility(receipt, visibilityTimeoutSeconds) { await call({ Action: 'ChangeMessageVisibility', ReceiptHandle: receipt, VisibilityTimeout: String(visibilityTimeoutSeconds) }); },
  };
}
