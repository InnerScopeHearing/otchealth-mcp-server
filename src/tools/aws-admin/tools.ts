/**
 * CTO-only, server-identity AWS control-plane router.
 *
 * This is deliberately an operation registry, not a caller-supplied AWS request proxy. Every
 * service, action, resource, region, and request shape is fixed here. The gateway's own ECS task
 * role is checked with STS before each tool invocation. No credentials, arbitrary ARN, S3 key,
 * Bedrock resource, IAM policy, ECS task definition, or endpoint is accepted from the caller.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import {
  AWS_ADMIN_ACCOUNT_ID, AWS_ADMIN_BUCKET, AWS_ADMIN_ECS_CLUSTER, AWS_ADMIN_ECS_SERVICE,
  AWS_ADMIN_KB_POLICY_NAME, AWS_ADMIN_KB_ROLE_NAME, AWS_ADMIN_PUBLIC_DATA_SOURCE_ID, AWS_ADMIN_PUBLIC_KB_ID,
  AWS_ADMIN_PUBLIC_PREFIX, AWS_ADMIN_PUBLIC_SOURCES, AWS_ADMIN_PUBLIC_SOURCE_VERSIONS, AWS_ADMIN_TASK_ROLE_NAME,
  AWS_ADMIN_REGION, MAX_PUBLIC_DOCUMENT_BYTES, canUpdatePublicDataSource,
  expectedPublicSourceHash, isDedicatedPublicKb, isPublicSourceId,
  isSafePublicSourceSet, mergePublicReadStatement, parsePublicDataSourceScope,
  publicMetadataKey, publicSourceKey, runtimeTaskRoleArnMatches,
  sha256Hex, type PublicSourceId,
} from './policy.js';

const MAX_AWS_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_INGESTION_JOB_ID = /^[A-Za-z0-9-]{1,100}$/;
const SAFE_VERSION_ID = /^[A-Za-z0-9./_+=-]{1,256}$/;

const READ_OPERATIONS = [
  's3_list_public_documents', 's3_list_public_versions', 's3_get_public_document', 's3_head_public_document',
  'bedrock_get_knowledge_base', 'bedrock_list_data_sources', 'bedrock_get_data_source',
  'bedrock_list_ingestion_jobs', 'bedrock_get_ingestion_job',
  'iam_get_kb_execution_role', 'iam_get_kb_execution_role_policy', 'iam_simulate_kb_public_read',
  'ecs_describe_gateway_service', 'ecs_describe_gateway_task_definition',
] as const;

const WRITE_OPERATIONS = [
  's3_put_public_document', 'bedrock_update_public_data_source', 'bedrock_start_public_ingestion',
  'iam_ensure_kb_public_read_policy', 'ecs_force_new_gateway_deployment',
] as const;

const sourceIdSchema = z.string().refine(isPublicSourceId, 'source_id is not in the two-document public pilot allowlist');
const inputShape = {
  operation: z.enum(READ_OPERATIONS),
  source_id: sourceIdSchema.optional(),
  version_id: z.string().min(1).max(256).optional(),
  ingestion_job_id: z.string().regex(SAFE_INGESTION_JOB_ID).optional(),
  iam_action: z.enum([
    's3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:ListBucketVersions',
    'bedrock:Retrieve', 'bedrock:ListDataSources', 'bedrock:GetDataSource', 'bedrock:GetKnowledgeBase',
    'bedrock:UpdateDataSource', 'bedrock:StartIngestionJob',
    'ecs:DescribeServices', 'ecs:UpdateService', 'iam:GetRole', 'iam:GetRolePolicy',
    'iam:SimulatePrincipalPolicy', 'iam:PutRolePolicy',
  ]).optional(),
} satisfies z.ZodRawShape;

const writeInputShape = {
  operation: z.enum(WRITE_OPERATIONS),
  source_id: sourceIdSchema.optional(),
  content: z.string().max(MAX_PUBLIC_DOCUMENT_BYTES).optional(),
  confirm_live: z.boolean().optional(),
} satisfies z.ZodRawShape;

type ReadInput = z.infer<z.ZodObject<typeof inputShape>>;
type WriteInput = z.infer<z.ZodObject<typeof writeInputShape>>;

type AwsAdminDependencies = {
  credentials: () => Promise<AwsCredentials | null>;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
};

const DEFAULT_DEPENDENCIES: AwsAdminDependencies = {
  credentials: resolveAwsCredentials,
  fetch: (...args) => fetch(...args),
  env: process.env,
};

class AwsAdminError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AwsAdminError';
  }
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const hex = /^&#x([\da-f]+);$/i.exec(entity);
    if (hex) return String.fromCodePoint(Number.parseInt(hex[1]!, 16));
    const decimal = /^&#(\d+);$/.exec(entity);
    return decimal ? String.fromCodePoint(Number.parseInt(decimal[1]!, 10)) : entity;
  });
}

function xmlText(xml: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]!.trim()) : null;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...xml.matchAll(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'gi'))].map((match) => match[1]!);
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AwsAdminError('aws_response_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AwsAdminError('aws_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

function awsErrorCode(body: string): string | undefined {
  const fromXml = xmlText(body, 'Code');
  if (fromXml && /^[A-Za-z0-9._-]{1,80}$/.test(fromXml)) return fromXml;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const value = parsed.__type ?? parsed.code ?? parsed.Code;
    if (typeof value === 'string') {
      const match = /(?:#|:)?([A-Za-z0-9._-]{1,80})$/.exec(value);
      if (match) return match[1];
    }
  } catch { /* provider body was not JSON */ }
  return undefined;
}

function decodeIamDocument(value: string | null): unknown {
  if (!value) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value.replace(/\+/g, ' ')); } catch { /* already plain XML text */ }
  try { return JSON.parse(decoded) as unknown; } catch { throw new AwsAdminError('iam_policy_document_invalid'); }
}

function getAwsTarget(deps: AwsAdminDependencies, name: 'AWS_ADMIN_PUBLIC_KB_ID' | 'AWS_ADMIN_PUBLIC_DATA_SOURCE_ID'): string {
  const fallback = name === 'AWS_ADMIN_PUBLIC_KB_ID' ? AWS_ADMIN_PUBLIC_KB_ID : AWS_ADMIN_PUBLIC_DATA_SOURCE_ID;
  const value = deps.env[name] ?? fallback;
  if (value !== fallback) throw new AwsAdminError('public_kb_target_does_not_match_fixed_allowlist');
  return value;
}

function assertDedicatedPublicTarget(kbId: string, dataSourceId: string): void {
  if (!isDedicatedPublicKb(kbId, dataSourceId)) throw new AwsAdminError('mixed_knowledge_base_or_data_source_refused');
}

function s3Host(): string { return `${AWS_ADMIN_BUCKET}.s3.${AWS_ADMIN_REGION}.amazonaws.com`; }
function bedrockHost(): string { return `bedrock.${AWS_ADMIN_REGION}.amazonaws.com`; }
function encodePathKey(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function signedResponse(
  deps: AwsAdminDependencies,
  credentials: AwsCredentials,
  options: { method: string; service: string; host: string; path: string; query?: Record<string, string>; body?: string | Buffer; headers?: Record<string, string> },
): Promise<Response> {
  const signed = signRequest({
    method: options.method,
    host: options.host,
    path: options.path,
    query: options.query,
    body: options.body,
    region: AWS_ADMIN_REGION,
    service: options.service,
    credentials,
    extraHeaders: options.headers,
  });
  return deps.fetch(`https://${options.host}${options.path}${options.query ? `?${new URLSearchParams(options.query).toString()}` : ''}`, {
    method: options.method,
    headers: signed.headers,
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : options.body,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
}

async function responseJson(response: Response): Promise<unknown> {
  const raw = (await readBounded(response, MAX_AWS_RESPONSE_BYTES)).toString('utf8');
  if (!response.ok) throw new AwsAdminError(`aws_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
  try { return raw ? JSON.parse(raw) as unknown : {}; } catch { throw new AwsAdminError('aws_response_invalid_json'); }
}

async function assertTaskIdentity(deps: AwsAdminDependencies, credentials: AwsCredentials): Promise<void> {
  const body = new URLSearchParams({ Action: 'GetCallerIdentity', Version: '2011-06-15' }).toString();
  const response = await signedResponse(deps, credentials, {
    method: 'POST', service: 'sts', host: `sts.${AWS_ADMIN_REGION}.amazonaws.com`, path: '/', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
  const raw = (await readBounded(response, 64 * 1024)).toString('utf8');
  if (!response.ok) throw new AwsAdminError(`sts_identity_http_${response.status}`);
  const account = xmlText(raw, 'Account') ?? '';
  const arn = xmlText(raw, 'Arn') ?? '';
  if (!runtimeTaskRoleArnMatches(account, arn)) throw new AwsAdminError('aws_runtime_identity_not_otchealth_task_role');
}

async function authenticatedCredentials(deps: AwsAdminDependencies): Promise<AwsCredentials> {
  const credentials = await deps.credentials();
  if (!credentials) throw new AwsAdminError('aws_runtime_credentials_unavailable');
  await assertTaskIdentity(deps, credentials);
  return credentials;
}

async function bedrockJson(
  deps: AwsAdminDependencies,
  credentials: AwsCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const response = await signedResponse(deps, credentials, {
    method, service: 'bedrock', host: bedrockHost(), path, body: serialized,
    headers: serialized ? { 'content-type': 'application/json' } : undefined,
  });
  return responseJson(response);
}

async function s3Raw(
  deps: AwsAdminDependencies,
  credentials: AwsCredentials,
  method: string,
  key: string | null,
  query?: Record<string, string>,
  body?: Buffer,
  headers?: Record<string, string>,
): Promise<Response> {
  if (key !== null && !key.startsWith(AWS_ADMIN_PUBLIC_PREFIX)) throw new AwsAdminError('s3_key_outside_public_prefix');
  return signedResponse(deps, credentials, {
    method, service: 's3', host: s3Host(), path: key === null ? '/' : `/${encodePathKey(key)}`,
    query, body, headers,
  });
}

async function getPublicObject(
  deps: AwsAdminDependencies,
  credentials: AwsCredentials,
  key: string,
  versionId?: string,
  maxBytes = MAX_PUBLIC_DOCUMENT_BYTES,
): Promise<{ body: Buffer; versionId: string; contentType: string | null }> {
  const response = await s3Raw(deps, credentials, 'GET', key, versionId ? { versionId } : undefined);
  if (!response.ok) {
    const raw = (await readBounded(response, 64 * 1024)).toString('utf8');
    throw new AwsAdminError(`s3_get_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
  }
  const actualVersion = response.headers.get('x-amz-version-id');
  if (!actualVersion) throw new AwsAdminError('s3_bucket_version_id_missing');
  return {
    body: await readBounded(response, maxBytes),
    versionId: actualVersion,
    contentType: response.headers.get('content-type'),
  };
}

async function listPublicKeys(deps: AwsAdminDependencies, credentials: AwsCredentials): Promise<string[]> {
  const response = await s3Raw(deps, credentials, 'GET', null, {
    'list-type': '2', prefix: AWS_ADMIN_PUBLIC_PREFIX, 'max-keys': '1000',
  });
  const raw = (await readBounded(response, 512 * 1024)).toString('utf8');
  if (!response.ok) throw new AwsAdminError(`s3_list_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
  if (xmlText(raw, 'IsTruncated') === 'true') throw new AwsAdminError('public_prefix_inventory_truncated');
  return xmlBlocks(raw, 'Contents').map((block) => xmlText(block, 'Key')).filter((key): key is string => Boolean(key));
}

function publicObjectSummary(raw: string): { source_id: PublicSourceId; version_id: string; latest: boolean; last_modified: string | null } | null {
  const key = xmlText(raw, 'Key') ?? '';
  const match = new RegExp(`^${AWS_ADMIN_PUBLIC_PREFIX}([a-f0-9]{64})\\.txt$`).exec(key);
  if (!match || !isPublicSourceId(match[1]!)) return null;
  const versionId = xmlText(raw, 'VersionId');
  if (!versionId || !SAFE_VERSION_ID.test(versionId)) return null;
  return {
    source_id: match[1],
    version_id: versionId,
    latest: xmlText(raw, 'IsLatest') === 'true',
    last_modified: xmlText(raw, 'LastModified'),
  };
}

async function listPublicVersions(deps: AwsAdminDependencies, credentials: AwsCredentials, sourceId?: string): Promise<unknown> {
  const sourceIds = sourceId ? [sourceId] : Object.keys(AWS_ADMIN_PUBLIC_SOURCES);
  const results: unknown[] = [];
  for (const id of sourceIds) {
    if (!isPublicSourceId(id)) throw new AwsAdminError('public_source_not_allowlisted');
    const key = publicSourceKey(id)!;
    const response = await s3Raw(deps, credentials, 'GET', null, { versions: '', prefix: key, 'max-keys': '100' });
    const raw = (await readBounded(response, 512 * 1024)).toString('utf8');
    if (!response.ok) throw new AwsAdminError(`s3_versions_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
    if (xmlText(raw, 'IsTruncated') === 'true') throw new AwsAdminError('public_version_inventory_truncated');
    const versions = xmlBlocks(raw, 'Version').map(publicObjectSummary).filter((value): value is NonNullable<typeof value> => Boolean(value));
    results.push(...versions);
  }
  return { versions: results, count: results.length };
}

function verifySourceText(sourceId: string, body: Buffer): string {
  const expected = expectedPublicSourceHash(sourceId);
  if (!expected || body.byteLength > MAX_PUBLIC_DOCUMENT_BYTES || sha256Hex(body) !== expected) {
    throw new AwsAdminError('public_source_hash_or_size_mismatch');
  }
  return body.toString('utf8');
}

async function parseGetDataSource(deps: AwsAdminDependencies, credentials: AwsCredentials, kbId: string, dataSourceId: string): Promise<Record<string, any>> {
  const result = await bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}/datasources/${dataSourceId}`) as Record<string, any>;
  if (!result || typeof result !== 'object' || !result.dataSource || typeof result.dataSource !== 'object') throw new AwsAdminError('bedrock_data_source_response_invalid');
  return result.dataSource as Record<string, any>;
}

function targetPublicResources(deps: AwsAdminDependencies): { kbId: string; dataSourceId: string } {
  const kbId = getAwsTarget(deps, 'AWS_ADMIN_PUBLIC_KB_ID');
  const dataSourceId = getAwsTarget(deps, 'AWS_ADMIN_PUBLIC_DATA_SOURCE_ID');
  assertDedicatedPublicTarget(kbId, dataSourceId);
  return { kbId, dataSourceId };
}

function unwrapAndValidateTrust(xml: string): unknown {
  const encoded = xmlText(xml, 'AssumeRolePolicyDocument');
  const policy = decodeIamDocument(encoded);
  const statements = Array.isArray((policy as any)?.Statement) ? (policy as any).Statement : [(policy as any)?.Statement].filter(Boolean);
  const allow = statements.filter((statement: any) => statement?.Effect !== 'Deny');
  if (!allow.length) throw new AwsAdminError('kb_role_trust_not_bedrock_only');
  for (const statement of allow) {
    const principal = statement?.Principal;
    if (!principal || typeof principal !== 'object' || Array.isArray(principal) ||
        Object.keys(principal).some((key) => key !== 'Service')) {
      throw new AwsAdminError('kb_role_trust_not_bedrock_only');
    }
    const services = principal.Service;
    const values = Array.isArray(services) ? services : [services];
    if (values.length !== 1 || values[0] !== 'bedrock.amazonaws.com') throw new AwsAdminError('kb_role_trust_not_bedrock_only');
    const actions = Array.isArray(statement?.Action) ? statement.Action : [statement?.Action];
    if (!actions.includes('sts:AssumeRole')) throw new AwsAdminError('kb_role_trust_not_bedrock_only');
    const expectedArn = `arn:aws:bedrock:${AWS_ADMIN_REGION}:${AWS_ADMIN_ACCOUNT_ID}:knowledge-base/${AWS_ADMIN_PUBLIC_KB_ID}`;
    if (!hasExactCondition(statement?.Condition, 'aws:SourceAccount', AWS_ADMIN_ACCOUNT_ID, ['StringEquals']) ||
        !hasExactCondition(statement?.Condition, 'aws:SourceArn', expectedArn, ['ArnEquals', 'ArnLike'])) {
      throw new AwsAdminError('kb_role_trust_missing_exact_source_conditions');
    }
  }
  return policy;
}

function hasExactCondition(value: unknown, expectedKey: string, expectedValue: string, allowedOperators: readonly string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const matches = Object.entries(value as Record<string, unknown>)
    .flatMap(([operator, entries]) => entries && typeof entries === 'object' && Object.hasOwn(entries, expectedKey)
      ? [{ operator, value: (entries as Record<string, unknown>)[expectedKey] }]
      : []);
  if (matches.length !== 1 || !allowedOperators.includes(matches[0]!.operator)) return false;
  const values = Array.isArray(matches[0]!.value) ? matches[0]!.value : [matches[0]!.value];
  return values.length === 1 && values[0] === expectedValue;
}

async function iamRequest(deps: AwsAdminDependencies, credentials: AwsCredentials, params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ ...params, Version: '2010-05-08' }).toString();
  const response = await signedResponse(deps, credentials, {
    method: 'POST', service: 'iam', host: 'iam.amazonaws.com', path: '/', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
  const raw = (await readBounded(response, MAX_AWS_RESPONSE_BYTES)).toString('utf8');
  if (!response.ok) throw new AwsAdminError(`iam_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
  return raw;
}

async function runRead(input: ReadInput, deps: AwsAdminDependencies, credentials: AwsCredentials): Promise<unknown> {
  switch (input.operation) {
    case 's3_list_public_documents': {
      const keys = await listPublicKeys(deps, credentials);
      const allowed = new Set(Object.keys(AWS_ADMIN_PUBLIC_SOURCES).flatMap((id) => [publicSourceKey(id)!, publicMetadataKey(id)!]));
      const visible = keys.filter((key) => allowed.has(key)).map((key) => ({ key: key.slice(AWS_ADMIN_PUBLIC_PREFIX.length), source_id: key.slice(AWS_ADMIN_PUBLIC_PREFIX.length, AWS_ADMIN_PUBLIC_PREFIX.length + 64) }));
      return { objects: visible, allowed_object_count: visible.length, unapproved_object_count: keys.length - visible.length };
    }
    case 's3_list_public_versions':
      if (input.source_id && !isPublicSourceId(input.source_id)) throw new AwsAdminError('public_source_not_allowlisted');
      return listPublicVersions(deps, credentials, input.source_id);
    case 's3_get_public_document': {
      if (!input.source_id || !isPublicSourceId(input.source_id) || !input.version_id || !SAFE_VERSION_ID.test(input.version_id)) throw new AwsAdminError('source_id_and_valid_version_id_required');
      const object = await getPublicObject(deps, credentials, publicSourceKey(input.source_id)!, input.version_id);
      return { source_id: input.source_id, version_id: object.versionId, source_sha256: expectedPublicSourceHash(input.source_id), content_type: object.contentType, text: verifySourceText(input.source_id, object.body) };
    }
    case 's3_head_public_document': {
      if (!input.source_id || !isPublicSourceId(input.source_id) || !input.version_id || !SAFE_VERSION_ID.test(input.version_id)) throw new AwsAdminError('source_id_and_valid_version_id_required');
      const response = await s3Raw(deps, credentials, 'HEAD', publicSourceKey(input.source_id), { versionId: input.version_id });
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        throw new AwsAdminError(`s3_head_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
      }
      return { source_id: input.source_id, version_id: response.headers.get('x-amz-version-id'), content_length: Number(response.headers.get('content-length') ?? 0), e_tag: response.headers.get('etag'), last_modified: response.headers.get('last-modified') };
    }
    case 'bedrock_get_knowledge_base': {
      const { kbId } = targetPublicResources(deps);
      return bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}`);
    }
    case 'bedrock_list_data_sources': {
      const { kbId } = targetPublicResources(deps);
      return bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}/datasources`);
    }
    case 'bedrock_get_data_source': {
      const { kbId, dataSourceId } = targetPublicResources(deps);
      return bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}/datasources/${dataSourceId}`);
    }
    case 'bedrock_list_ingestion_jobs': {
      const { kbId, dataSourceId } = targetPublicResources(deps);
      const result = await bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}/datasources/${dataSourceId}/ingestionjobs`) as any;
      const summaries = Array.isArray(result?.ingestionJobSummaries) ? result.ingestionJobSummaries : [];
      return { ...result, ingestionJobSummaries: summaries.map(summarizeIngestionJob) };
    }
    case 'bedrock_get_ingestion_job': {
      const { kbId, dataSourceId } = targetPublicResources(deps);
      if (!input.ingestion_job_id || !SAFE_INGESTION_JOB_ID.test(input.ingestion_job_id)) throw new AwsAdminError('ingestion_job_id_required');
      const result = await bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}/datasources/${dataSourceId}/ingestionjobs/${encodeURIComponent(input.ingestion_job_id)}`) as any;
      return { ingestionJob: summarizeIngestionJob(result?.ingestionJob) };
    }
    case 'iam_get_kb_execution_role': {
      const raw = await iamRequest(deps, credentials, { Action: 'GetRole', RoleName: AWS_ADMIN_KB_ROLE_NAME });
      const roleArn = xmlText(raw, 'Arn') ?? '';
      if (roleArn !== `arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/${AWS_ADMIN_KB_ROLE_NAME}`) throw new AwsAdminError('kb_execution_role_arn_mismatch');
      const trust = unwrapAndValidateTrust(raw);
      return { role_arn: roleArn, trust_policy: trust };
    }
    case 'iam_get_kb_execution_role_policy': {
      const raw = await iamRequest(deps, credentials, { Action: 'GetRolePolicy', RoleName: AWS_ADMIN_KB_ROLE_NAME, PolicyName: AWS_ADMIN_KB_POLICY_NAME });
      const roleName = xmlText(raw, 'RoleName');
      const policyName = xmlText(raw, 'PolicyName');
      if (roleName !== AWS_ADMIN_KB_ROLE_NAME || policyName !== AWS_ADMIN_KB_POLICY_NAME) throw new AwsAdminError('iam_policy_identity_mismatch');
      return { role_name: roleName, policy_name: policyName, policy_document: decodeIamDocument(xmlText(raw, 'PolicyDocument')) };
    }
    case 'iam_simulate_kb_public_read': {
      if (!input.iam_action) throw new AwsAdminError('iam_action_required');
      // The KB execution role owns S3 data-source access. Gateway Bedrock, IAM, and ECS calls
      // are made by otchealthTaskRole, including the fixed public KB Retrieve permission.
      const policySourceArn = input.iam_action.startsWith('s3:')
        ? `arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/${AWS_ADMIN_KB_ROLE_NAME}`
        : `arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/${AWS_ADMIN_TASK_ROLE_NAME}`;
      const resources = input.iam_action === 's3:ListBucket' || input.iam_action === 's3:ListBucketVersions'
        ? [`arn:aws:s3:::${AWS_ADMIN_BUCKET}`]
        : input.iam_action.startsWith('s3:')
          ? Object.keys(AWS_ADMIN_PUBLIC_SOURCES).map((id) => `arn:aws:s3:::${AWS_ADMIN_BUCKET}/${publicSourceKey(id)}`)
          : input.iam_action.startsWith('bedrock:')
            ? [`arn:aws:bedrock:${AWS_ADMIN_REGION}:${AWS_ADMIN_ACCOUNT_ID}:knowledge-base/${getAwsTarget(deps, 'AWS_ADMIN_PUBLIC_KB_ID')}`]
            : input.iam_action.startsWith('ecs:')
              ? [`arn:aws:ecs:${AWS_ADMIN_REGION}:${AWS_ADMIN_ACCOUNT_ID}:service/${AWS_ADMIN_ECS_CLUSTER}/${AWS_ADMIN_ECS_SERVICE}`]
              : [`arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/${AWS_ADMIN_KB_ROLE_NAME}`];
      const params: Record<string, string> = {
        Action: 'SimulatePrincipalPolicy',
        PolicySourceArn: policySourceArn,
        'ActionNames.member.1': input.iam_action,
      };
      resources.forEach((resource, index) => { params[`ResourceArns.member.${index + 1}`] = resource; });
      const raw = await iamRequest(deps, credentials, params);
      const results = xmlBlocks(raw, 'EvaluationResult').map((block) => ({
        action: xmlText(block, 'EvalActionName'),
        resource: xmlText(block, 'EvalResourceName'),
        decision: xmlText(block, 'EvalDecision'),
        missing_context_values: xmlBlocks(block, 'MissingContextValues').flatMap((item) => xmlBlocks(item, 'member').map(decodeXml)),
      }));
      return { role_arn: policySourceArn, evaluations: results };
    }
    case 'ecs_describe_gateway_service': {
      const body = JSON.stringify({ cluster: AWS_ADMIN_ECS_CLUSTER, services: [AWS_ADMIN_ECS_SERVICE] });
      const response = await signedResponse(deps, credentials, {
        method: 'POST', service: 'ecs', host: `ecs.${AWS_ADMIN_REGION}.amazonaws.com`, path: '/', body,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonEC2ContainerServiceV20141113.DescribeServices' },
      });
      const raw = await responseJson(response) as any;
      return { services: (raw?.services ?? []).map((service: any) => ({
        service_name: service.serviceName, status: service.status, desired_count: service.desiredCount,
        running_count: service.runningCount, pending_count: service.pendingCount,
        deployments: (service.deployments ?? []).map((item: any) => ({ status: item.status, desired_count: item.desiredCount, running_count: item.runningCount, task_definition: item.taskDefinition })),
      })), failures: (raw?.failures ?? []).map((failure: any) => ({ arn: failure.arn, reason: failure.reason })),
      };
    }
    case 'ecs_describe_gateway_task_definition': {
      const body = JSON.stringify({ taskDefinition: 'otchealth-gateway' });
      const response = await signedResponse(deps, credentials, {
        method: 'POST', service: 'ecs', host: `ecs.${AWS_ADMIN_REGION}.amazonaws.com`, path: '/', body,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonEC2ContainerServiceV20141113.DescribeTaskDefinition' },
      });
      const raw = await responseJson(response) as any;
      const task = raw?.taskDefinition;
      if (!task || task.family !== 'otchealth-gateway') throw new AwsAdminError('gateway_task_definition_identity_mismatch');
      return { task_definition_arn: task.taskDefinitionArn, family: task.family, revision: task.revision, status: task.status, task_role_arn: task.taskRoleArn, execution_role_arn: task.executionRoleArn, containers: (task.containerDefinitions ?? []).map((container: any) => ({ name: container.name, image: container.image, port_mappings: container.portMappings, environment_names: (container.environment ?? []).map((item: any) => item.name), secret_names: (container.secrets ?? []).map((item: any) => item.name) })) };
    }
  }
}

async function prepareIngestion(deps: AwsAdminDependencies, credentials: AwsCredentials, kbId: string, dataSourceId: string): Promise<unknown> {
  const dataSource = await parseGetDataSource(deps, credentials, kbId, dataSourceId);
  if (parsePublicDataSourceScope(dataSource) !== 'company_shared') throw new AwsAdminError('mixed_or_non_public_data_source_ingestion_refused');
  const keys = await listPublicKeys(deps, credentials);
  if (!isSafePublicSourceSet(keys)) throw new AwsAdminError('public_prefix_contains_unapproved_objects');
  const sourceVersions: Array<{ source_id: string; version_id: string; source_sha256: string }> = [];
  for (const sourceId of Object.keys(AWS_ADMIN_PUBLIC_SOURCES)) {
    const sourceKey = publicSourceKey(sourceId)!;
    const source = await getPublicObject(deps, credentials, sourceKey);
    const pinned = AWS_ADMIN_PUBLIC_SOURCE_VERSIONS[sourceId as PublicSourceId];
    if (source.versionId !== pinned.document) throw new AwsAdminError('public_source_version_does_not_match_approved_pin');
    const text = verifySourceText(sourceId, source.body);
    if (!text.trim()) throw new AwsAdminError('public_source_empty');
    sourceVersions.push({ source_id: sourceId, version_id: source.versionId, source_sha256: expectedPublicSourceHash(sourceId)! });
  }
  return {
    source_versions: sourceVersions,
    document_count: sourceVersions.length,
    optional_metadata_sidecar_count: keys.filter((key) => key.endsWith('.txt.metadata.json')).length,
    object_count: keys.length,
    metadata_sidecars_required: false,
  };
}

function summarizeIngestionJob(raw: any): Record<string, unknown> {
  const job = raw && typeof raw === 'object' ? raw : {};
  const stats = job.statistics && typeof job.statistics === 'object' ? job.statistics : {};
  const count = (name: string): number | null => Number.isFinite(stats[name]) ? stats[name] : null;
  const newIndexed = count('numberOfNewDocumentsIndexed');
  const modifiedIndexed = count('numberOfModifiedDocumentsIndexed');
  return {
    ingestion_job_id: typeof job.ingestionJobId === 'string' ? job.ingestionJobId : null,
    knowledge_base_id: typeof job.knowledgeBaseId === 'string' ? job.knowledgeBaseId : null,
    data_source_id: typeof job.dataSourceId === 'string' ? job.dataSourceId : null,
    status: typeof job.status === 'string' ? job.status : null,
    started_at: typeof job.startedAt === 'string' ? job.startedAt : null,
    updated_at: typeof job.updatedAt === 'string' ? job.updatedAt : null,
    statistics: {
      documents_scanned: count('numberOfDocumentsScanned'),
      new_documents_indexed: newIndexed,
      modified_documents_indexed: modifiedIndexed,
      documents_indexed: newIndexed === null || modifiedIndexed === null ? null : newIndexed + modifiedIndexed,
      documents_failed: count('numberOfDocumentsFailed'),
      metadata_documents_scanned: count('numberOfMetadataDocumentsScanned'),
      metadata_documents_modified: count('numberOfMetadataDocumentsModified'),
      documents_deleted: count('numberOfDocumentsDeleted'),
      documents_skipped: count('numberOfDocumentsSkipped'),
    },
    failure_reasons: Array.isArray(job.failureReasons) ? job.failureReasons : [],
  };
}

async function runWrite(input: WriteInput, deps: AwsAdminDependencies, credentials: AwsCredentials): Promise<unknown> {
  switch (input.operation) {
    case 's3_put_public_document': {
      if (!input.source_id || !isPublicSourceId(input.source_id) || typeof input.content !== 'string') throw new AwsAdminError('source_id_and_content_required');
      if (sha256Hex(input.content) !== expectedPublicSourceHash(input.source_id)) throw new AwsAdminError('public_source_hash_or_size_mismatch');
      const key = publicSourceKey(input.source_id)!;
      const body = Buffer.from(input.content, 'utf8');
      const response = await s3Raw(deps, credentials, 'PUT', key, undefined, body, {
        'content-type': 'text/plain; charset=utf-8',
        'if-none-match': '*',
        'x-amz-server-side-encryption': 'AES256',
        'x-amz-meta-source-id': input.source_id,
        'x-amz-meta-source-sha256': expectedPublicSourceHash(input.source_id)!,
        'x-amz-meta-source-group': 'company_shared',
        'x-amz-meta-source-scope': 'company_shared',
        'x-amz-meta-source-version': `sha256:${expectedPublicSourceHash(input.source_id)}`,
      });
      const raw = (await readBounded(response, 64 * 1024)).toString('utf8');
      if (!response.ok) throw new AwsAdminError(`s3_put_http_${response.status}${awsErrorCode(raw) ? `_${awsErrorCode(raw)}` : ''}`);
      const versionId = response.headers.get('x-amz-version-id');
      if (!versionId) throw new AwsAdminError('s3_bucket_version_id_missing');
      return { source_id: input.source_id, source_sha256: expectedPublicSourceHash(input.source_id), version_id: versionId, key: key.slice(AWS_ADMIN_PUBLIC_PREFIX.length), created_only: true };
    }
    case 'bedrock_update_public_data_source': {
      const { kbId, dataSourceId } = targetPublicResources(deps);
      const current = await parseGetDataSource(deps, credentials, kbId, dataSourceId);
      if (!canUpdatePublicDataSource(current)) throw new AwsAdminError('mixed_or_non_public_data_source_update_refused');
      if (parsePublicDataSourceScope(current) === 'company_shared') return { updated: false, data_source_id: dataSourceId, inclusion_prefix: AWS_ADMIN_PUBLIC_PREFIX, reason: 'already_configured' };
      const configuration = structuredClone(current.dataSourceConfiguration);
      configuration.s3Configuration.inclusionPrefixes = [AWS_ADMIN_PUBLIC_PREFIX];
      const payload = {
        name: current.name,
        ...(typeof current.description === 'string' ? { description: current.description } : {}),
        dataSourceConfiguration: configuration,
        ...(current.vectorIngestionConfiguration ? { vectorIngestionConfiguration: current.vectorIngestionConfiguration } : {}),
      };
      const result = await bedrockJson(deps, credentials, 'PUT', `/knowledgebases/${kbId}/datasources/${dataSourceId}`, payload);
      return { updated: true, knowledge_base_id: kbId, data_source_id: dataSourceId, inclusion_prefix: AWS_ADMIN_PUBLIC_PREFIX, result };
    }
    case 'bedrock_start_public_ingestion': {
      const { kbId, dataSourceId } = targetPublicResources(deps);
      const preflight = await prepareIngestion(deps, credentials, kbId, dataSourceId);
      const jobs = await bedrockJson(deps, credentials, 'GET', `/knowledgebases/${kbId}/datasources/${dataSourceId}/ingestionjobs`) as any;
      const summaries = Array.isArray(jobs?.ingestionJobSummaries) ? jobs.ingestionJobSummaries : [];
      if (summaries.some((job: any) => job?.status === 'IN_PROGRESS')) throw new AwsAdminError('bedrock_ingestion_already_in_progress');
      const result = await bedrockJson(deps, credentials, 'PUT', `/knowledgebases/${kbId}/datasources/${dataSourceId}/ingestionjobs/`, {
        clientToken: randomUUID(),
        description: 'CTO-controlled immutable public company_shared pilot source sync',
      }) as any;
      return { preflight, ingestion_job: summarizeIngestionJob(result?.ingestionJob) };
    }
    case 'iam_ensure_kb_public_read_policy': {
      const roleArn = `arn:aws:iam::${AWS_ADMIN_ACCOUNT_ID}:role/${AWS_ADMIN_KB_ROLE_NAME}`;
      const roleRaw = await iamRequest(deps, credentials, { Action: 'GetRole', RoleName: AWS_ADMIN_KB_ROLE_NAME });
      if ((xmlText(roleRaw, 'Arn') ?? '') !== roleArn) throw new AwsAdminError('kb_execution_role_arn_mismatch');
      unwrapAndValidateTrust(roleRaw);
      let policy: unknown = { Version: '2012-10-17', Statement: [] };
      try {
        const currentRaw = await iamRequest(deps, credentials, { Action: 'GetRolePolicy', RoleName: AWS_ADMIN_KB_ROLE_NAME, PolicyName: AWS_ADMIN_KB_POLICY_NAME });
        if (xmlText(currentRaw, 'RoleName') !== AWS_ADMIN_KB_ROLE_NAME || xmlText(currentRaw, 'PolicyName') !== AWS_ADMIN_KB_POLICY_NAME) throw new AwsAdminError('iam_policy_identity_mismatch');
        policy = decodeIamDocument(xmlText(currentRaw, 'PolicyDocument')) ?? policy;
      } catch (error) {
        if (!(error instanceof AwsAdminError) || !error.code.includes('NoSuchEntity')) throw error;
      }
      const merged = mergePublicReadStatement(policy);
      if (JSON.stringify(merged) === JSON.stringify(policy)) return { updated: false, role_arn: roleArn, policy_name: AWS_ADMIN_KB_POLICY_NAME, permission: 's3:GetObject on fixed company_shared prefix' };
      await iamRequest(deps, credentials, {
        Action: 'PutRolePolicy', RoleName: AWS_ADMIN_KB_ROLE_NAME,
        PolicyName: AWS_ADMIN_KB_POLICY_NAME, PolicyDocument: JSON.stringify(merged),
      });
      return { updated: true, role_arn: roleArn, policy_name: AWS_ADMIN_KB_POLICY_NAME, permission: 's3:GetObject on fixed company_shared prefix' };
    }
    case 'ecs_force_new_gateway_deployment': {
      if (input.confirm_live !== true) throw new AwsAdminError('explicit_force_redeploy_confirmation_required');
      const body = JSON.stringify({ cluster: AWS_ADMIN_ECS_CLUSTER, service: AWS_ADMIN_ECS_SERVICE, forceNewDeployment: true });
      const response = await signedResponse(deps, credentials, {
        method: 'POST', service: 'ecs', host: `ecs.${AWS_ADMIN_REGION}.amazonaws.com`, path: '/', body,
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonEC2ContainerServiceV20141113.UpdateService' },
      });
      const raw = await responseJson(response) as any;
      const service = raw?.service;
      if (service?.serviceName !== AWS_ADMIN_ECS_SERVICE) throw new AwsAdminError('ecs_service_identity_mismatch');
      return { service_name: service.serviceName, status: 'restart requested', service_status: service.status, deployment_count: Array.isArray(service.deployments) ? service.deployments.length : 0 };
    }
  }
}

function operationInputForLog(input: Record<string, unknown>): Record<string, unknown> {
  return {
    operation: input.operation,
    ...(typeof input.source_id === 'string' ? { source_id: input.source_id } : {}),
    ...(typeof input.version_id === 'string' ? { version_id_supplied: true } : {}),
    ...(typeof input.ingestion_job_id === 'string' ? { ingestion_job_id_supplied: true } : {}),
    ...(typeof input.iam_action === 'string' ? { iam_action: input.iam_action } : {}),
    ...(typeof input.content === 'string' ? { content_redacted: true, content_length: input.content.length } : {}),
    ...(typeof input.confirm_live === 'boolean' ? { confirm_live: input.confirm_live } : {}),
  };
}

function safeFailure(error: unknown): string {
  return error instanceof AwsAdminError ? error.code : 'aws_operation_failed';
}

export function registerAwsAdminTools(
  server: McpServer,
  callerHash: CallerHashProvider,
  dependencies: Partial<AwsAdminDependencies> = {},
): void {
  const deps: AwsAdminDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };

  registerTool(server, {
    name: 'aws_api_query',
    category: 'read',
    annotations: { title: 'AWS: bounded CTO operation query', description: 'CTO-only fixed AWS operation registry for the two exact public GraphRAG source IDs, a dedicated public Bedrock knowledge base, the fixed Bedrock execution role, and the gateway ECS service. The server verifies its AWS STS identity for every invocation. This is not an arbitrary AWS API proxy.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape,
    outputShape: { operation: z.string(), result: z.unknown().optional(), error: z.string().optional() },
    redactInputForLog: operationInputForLog,
    shieldInputForScan: (input) => ({ operation: input.operation, iam_action: input.iam_action, source_id: input.source_id }),
    handler: async (input, ctx) => {
      if (ctx.callerAgent !== 'cto') return { data: { operation: input.operation, error: 'forbidden_lane' }, summary: 'AWS control-plane reads are CTO-only.' };
      try {
        const credentials = await authenticatedCredentials(deps);
        const result = await runRead(input, deps, credentials);
        return { data: { operation: input.operation, result }, summary: `${input.operation} completed against the fixed AWS allowlist.` };
      } catch (error) {
        const code = safeFailure(error);
        return { data: { operation: input.operation, error: code }, summary: `AWS operation refused or unavailable: ${code}.` };
      }
    },
  }, callerHash);

  registerTool(server, {
    name: 'aws_api_operation',
    category: 'write_orchestrated',
    annotations: { title: 'AWS: bounded CTO operation', description: 'CTO-only fixed AWS write registry. Every call verifies the server AWS identity, keeps S3 writes to two exact public documents and hashes, Bedrock updates/ingestion to a separately configured company_shared-only KB/data source, IAM policy addition to the Bedrock-only execution role and one S3 prefix, or ECS force-new deployment of the existing gateway service. Writes require non-dry-run, global write/high-risk gates, and AWS_ADMIN_ENABLE_WRITES; only ECS force-new deployment requires explicit confirm_live. No arbitrary AWS API calls or resources.', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputShape: writeInputShape,
    outputShape: { operation: z.string(), executed: z.boolean(), result: z.unknown().optional(), error: z.string().optional() },
    redactInputForLog: operationInputForLog,
    shieldInputForScan: (input) => ({ operation: input.operation, source_id: input.source_id, confirm_live: input.confirm_live }),
    handler: async (input, ctx) => {
      if (ctx.callerAgent !== 'cto') return { data: { operation: input.operation, executed: false, error: 'forbidden_lane' }, summary: 'AWS control-plane writes are CTO-only.' };
      if (ctx.dryRun) return { data: { operation: input.operation, executed: false, dry_run: true }, summary: `Dry run only. ${input.operation} was not executed.` };
      if (deps.env.AWS_ADMIN_ENABLE_WRITES !== 'true') return { data: { operation: input.operation, executed: false, error: 'aws_admin_writes_disabled' }, summary: 'AWS_ADMIN_ENABLE_WRITES is not true; no AWS write was executed.' };
      try {
        const credentials = await authenticatedCredentials(deps);
        const result = await runWrite(input, deps, credentials);
        return { data: { operation: input.operation, executed: true, result }, audit: { before: null, after: { operation: input.operation, ...operationInputForLog(input as Record<string, unknown>) } }, summary: `${input.operation} completed against the fixed AWS allowlist.` };
      } catch (error) {
        const code = safeFailure(error);
        return { data: { operation: input.operation, executed: false, error: code }, summary: `AWS operation refused or unavailable: ${code}.` };
      }
    },
  }, callerHash);
}

export const awsAdminTesting = {
  decodeXml, xmlText, xmlBlocks, decodeIamDocument, assertTaskIdentity, authenticatedCredentials,
  runRead, runWrite, targetPublicResources, prepareIngestion, summarizeIngestionJob, defaults: DEFAULT_DEPENDENCIES,
};
