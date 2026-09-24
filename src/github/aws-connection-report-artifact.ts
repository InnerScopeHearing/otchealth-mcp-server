import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { parseStrictJson } from './graphrag-observation-receipt.js';

export const AWS_CONNECTION_REPORT_ARTIFACT = Object.freeze({
  owner: 'InnerScopeHearing',
  repo: 'otchealth-cto',
  name: 'aws-connection-report',
  receiptSchema: 'ai-os-aws-redacted-report-receipt-v1',
  workflowName: 'aws-health-monitor',
  workflowPath: '.github/workflows/aws-health-monitor.yml@main',
  headBranch: 'main',
  allowedEvents: Object.freeze(['schedule', 'workflow_dispatch'] as const),
  reportFile: 'aws-connection-report.json',
  receiptFile: 'receipt.json',
  retrieval: 'GitHub Actions artifact aws-connection-report, artifact file aws-report-artifact/aws-connection-report.json',
});

export const MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES = 1024 * 1024;
const MAX_AWS_CONNECTION_REPORT_JSON_BYTES = 512 * 1024;
const MAX_AWS_CONNECTION_REPORT_JSON_NODES = 16_384;
const ARTIFACT_STORAGE_PATH_PREFIX = '/actions-results/';
const ARTIFACT_STORAGE_HOSTS = new Set([
  'productionresultssa0.blob.core.windows.net',
  'productionresultssa1.blob.core.windows.net',
  'productionresultssa2.blob.core.windows.net',
  'productionresultssa3.blob.core.windows.net',
  'productionresultssa4.blob.core.windows.net',
  'productionresultssa5.blob.core.windows.net',
  'productionresultssa6.blob.core.windows.net',
  'productionresultssa7.blob.core.windows.net',
  'productionresultssa8.blob.core.windows.net',
  'productionresultssa9.blob.core.windows.net',
  'productionresultssa10.blob.core.windows.net',
  'productionresultssa11.blob.core.windows.net',
  'productionresultssa12.blob.core.windows.net',
  'productionresultssa13.blob.core.windows.net',
  'productionresultssa14.blob.core.windows.net',
  'productionresultssa15.blob.core.windows.net',
  'productionresultssa16.blob.core.windows.net',
  'productionresultssa17.blob.core.windows.net',
  'productionresultssa18.blob.core.windows.net',
  'productionresultssa19.blob.core.windows.net',
]);

const SENSITIVE_KEY_WORDS = new Set([
  'account', 'arn', 'resource', 'instance', 'bucket', 'secret', 'credential', 'token', 'password',
  'key', 'identifier', 'id', 'name', 'path', 'region', 'vpc', 'subnet', 'security', 'volume',
  'snapshot', 'endpoint', 'hostname', 'url', 'ip', 'principal', 'role', 'user', 'parameter',
]);
const SAFE_STATUS_VALUES = new Set([
  'ok', 'healthy', 'unhealthy', 'warning', 'warn', 'failed', 'failure', 'error', 'active', 'inactive',
  'running', 'stopped', 'available', 'unavailable', 'disabled', 'enabled', 'present', 'absent', 'clear',
  'alarm', 'complete', 'pass', 'passed', 'success', 'skipped', 'unknown', 'not_applicable',
  'not_configured', 'none', 'partial', 'not_enrolled', 'refused', 'container_shape_invalid',
  'ambiguous_or_plaintext_withheld', 'secret_reference_invalid', 'secret_reference', 'attention',
]);
// The trusted report producer currently emits no schema member in the report body.
const SAFE_REPORT_SCHEMA_VALUES: ReadonlySet<string> = new Set();
const AGGREGATE_CONTAINER_KEYS = new Set([
  'scope', 'summary', 'checks', 'services', 'service_status_counts', 'status_counts', 'errors', 'warnings',
  'ecs', 'gateway_http', 'rds', 'opensearch', 'neptune_stopper_alarm', 'cloudtrail_signin_metadata_last_hour',
]);
const AGGREGATE_STATUS_KEYS = new Set([
  'status', 'health', 'state', 'result', 'severity', 'mode', 'overall_status', 'observed_at_utc', 'schema',
]);
const AGGREGATE_NUMBER_KEY = /^(?:checks|healthy|unhealthy|available|unavailable|failed|failures|warnings|errors|successes|critical|count|total|.*(?:_count|_total|_bytes|_ms|_milliseconds|_seconds|_minutes|_percent|_percentage|_status_code|_last_hour))$/i;
const AGGREGATE_BOOLEAN_KEY = /^(?:enabled|active|present|healthy|available|read_only|.*(?:_present|_enabled|_active|_connected|_healthy|_available|_configured|_read_only))$/i;
const SAFE_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SENSITIVE_VALUE_PATTERNS = [
  /\barn:aws:[^\s"'<>]+/i,
  /\b\d{12}\b/,
  /\b(?:i|vpc|subnet|sg|eni|vol|snap|ami|db|fs|fsmt|fsap|nat|igw|eipalloc|eipassoc|rtb|acl|tgw|vpce)-[a-f0-9]{4,}\b/i,
  /(?:^|[\s/])\/(?:otchealth|aws\/secretsmanager|aws\/ssm)(?:\/|$)/i,
  /\b(?:https?|s3):\/\/\S+/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:secret|token|credential|password)\s*[:=]\s*\S+/i,
];

export interface AwsConnectionReportArtifactBindingInput {
  owner: unknown;
  repo: unknown;
  runId: unknown;
  artifactId: unknown;
  expectedSha256: unknown;
  repository: unknown;
  run: unknown;
  runArtifacts: unknown;
  artifact: unknown;
}

export interface ValidatedAwsConnectionReportArtifactBinding {
  expectedSha256: string;
  trustedArchiveSha256: string;
  repositoryId: number;
  archiveSizeBytes: number;
}

export interface AwsConnectionReportArchiveInspection {
  archiveBytes: number;
  archiveDigestVerified: true;
  archiveDigestStatus: 'github_artifact_digest_verified';
  callerExpectedDigestMatch: true;
  aggregateOnly: boolean;
  redactionPass: boolean;
}

function invalidProvenance(): never {
  throw new Error('AWS connection report artifact provenance is invalid');
}

function invalidArchive(): never {
  throw new Error('AWS connection report archive verification failed');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidProvenance();
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalidProvenance();
  return value;
}

function normalizeSha256(value: unknown): string {
  if (typeof value !== 'string') return invalidProvenance();
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return invalidProvenance();
  return normalized.toLowerCase();
}

function validateArtifactWorkflowRun(
  value: unknown,
  runId: number,
  repositoryId: number,
  headSha: string,
): void {
  const workflowRun = asRecord(value);
  if (workflowRun.id !== runId || workflowRun.repository_id !== repositoryId ||
      workflowRun.head_repository_id !== repositoryId || workflowRun.head_branch !== AWS_CONNECTION_REPORT_ARTIFACT.headBranch ||
      workflowRun.head_sha !== headSha) return invalidProvenance();
}

export function validateAwsConnectionReportArtifactBinding(
  input: AwsConnectionReportArtifactBindingInput,
): ValidatedAwsConnectionReportArtifactBinding {
  try {
    const owner = AWS_CONNECTION_REPORT_ARTIFACT.owner;
    const repo = AWS_CONNECTION_REPORT_ARTIFACT.repo;
    if (input.owner !== owner || input.repo !== repo) return invalidProvenance();
    const runId = safeInteger(input.runId, 1);
    const artifactId = safeInteger(input.artifactId, 1);
    const expectedSha256 = normalizeSha256(input.expectedSha256);
    const fullName = `${owner}/${repo}`;

    const repository = asRecord(input.repository);
    const repositoryId = safeInteger(repository.id, 1);
    if (repository.full_name !== fullName) return invalidProvenance();

    const run = asRecord(input.run);
    if (run.id !== runId) return invalidProvenance();
    const runRepository = asRecord(run.repository);
    if (runRepository.id !== repositoryId || runRepository.full_name !== fullName) return invalidProvenance();
    const headRepository = asRecord(run.head_repository);
    if (headRepository.id !== repositoryId || headRepository.full_name !== fullName ||
        run.head_branch !== AWS_CONNECTION_REPORT_ARTIFACT.headBranch ||
        typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/i.test(run.head_sha) ||
        run.name !== AWS_CONNECTION_REPORT_ARTIFACT.workflowName ||
        run.path !== AWS_CONNECTION_REPORT_ARTIFACT.workflowPath ||
        !AWS_CONNECTION_REPORT_ARTIFACT.allowedEvents.includes(run.event as 'schedule' | 'workflow_dispatch') ||
        run.status !== 'completed' || run.conclusion !== 'success') return invalidProvenance();
    const headSha = run.head_sha.toLowerCase();

    if (!Array.isArray(input.runArtifacts)) return invalidProvenance();
    const listedMatches = input.runArtifacts.filter((value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      return (value as Record<string, unknown>).id === artifactId;
    });
    if (listedMatches.length !== 1) return invalidProvenance();
    const listedArtifact = asRecord(listedMatches[0]);
    if (listedArtifact.name !== AWS_CONNECTION_REPORT_ARTIFACT.name) return invalidProvenance();
    const listedArchiveSha256 = normalizeSha256(listedArtifact.digest);
    if (listedArchiveSha256 !== expectedSha256) return invalidProvenance();
    validateArtifactWorkflowRun(listedArtifact.workflow_run, runId, repositoryId, headSha);

    const artifact = asRecord(input.artifact);
    if (artifact.id !== artifactId || artifact.name !== AWS_CONNECTION_REPORT_ARTIFACT.name || artifact.expired !== false) {
      return invalidProvenance();
    }
    const archiveSizeBytes = safeInteger(artifact.size_in_bytes, 1);
    if (archiveSizeBytes > MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES) return invalidProvenance();

    validateArtifactWorkflowRun(artifact.workflow_run, runId, repositoryId, headSha);
    const trustedArchiveSha256 = normalizeSha256(artifact.digest);
    if (trustedArchiveSha256 !== listedArchiveSha256 || trustedArchiveSha256 !== expectedSha256) return invalidProvenance();

    return { expectedSha256, trustedArchiveSha256, repositoryId, archiveSizeBytes };
  } catch {
    return invalidProvenance();
  }
}

export function validateGitHubActionsArtifactDownloadUrl(location: string | null): URL {
  if (typeof location !== 'string' || location.length === 0 || location.length > 8192) {
    throw new Error('GitHub Actions artifact redirect is invalid');
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error('GitHub Actions artifact redirect is invalid');
  }
  const hostname = url.hostname.toLowerCase();
  const isStorageShard = ARTIFACT_STORAGE_HOSTS.has(hostname) && url.pathname.startsWith(ARTIFACT_STORAGE_PATH_PREFIX);
  const approvedHost = hostname === 'pipelines.actions.githubusercontent.com' || isStorageShard;
  if (url.protocol !== 'https:' || !approvedHost || url.username !== '' || url.password !== '' ||
      (url.port !== '' && url.port !== '443') || url.hash !== '') {
    throw new Error('GitHub Actions artifact redirect is invalid');
  }
  return url;
}

function ensureRange(buffer: Buffer, offset: number, length: number, limit = buffer.length): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > limit) {
    invalidArchive();
  }
}

function readU16(buffer: Buffer, offset: number, limit = buffer.length): number {
  ensureRange(buffer, offset, 2, limit);
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number, limit = buffer.length): number {
  ensureRange(buffer, offset, 4, limit);
  return buffer.readUInt32LE(offset);
}

function validateExtraFields(buffer: Buffer, offset: number, length: number): void {
  ensureRange(buffer, offset, length);
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    ensureRange(buffer, cursor, 4, end);
    const fieldId = readU16(buffer, cursor, end);
    const fieldLength = readU16(buffer, cursor + 2, end);
    cursor += 4;
    ensureRange(buffer, cursor, fieldLength, end);
    if (fieldId === 0x0001 || fieldId === 0x7075 || fieldId === 0x6375) invalidArchive();
    cursor += fieldLength;
  }
  if (cursor !== end) invalidArchive();
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  checksum: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  nameLength: number;
  versionNeeded: number;
  externalAttributes: number;
}

function decodeSafeJsonName(buffer: Buffer, offset: number, length: number): string {
  ensureRange(buffer, offset, length);
  if (length < 6 || length > 128) return invalidArchive();
  const nameBytes = buffer.subarray(offset, offset + length);
  if (nameBytes.some((byte) => byte > 0x7f)) return invalidArchive();
  const name = nameBytes.toString('ascii');
  if (!/^[a-z0-9_.-]+\.json$/i.test(name) || name === '.' || name === '..' || name.includes('..\\')) return invalidArchive();
  return name;
}

function extractJsonMembers(archive: Buffer): Array<{ name: string; bytes: Buffer }> {
  if (archive.length < 22 || archive.length > MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES) return invalidArchive();

  const earliestEocd = Math.max(0, archive.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= earliestEocd; offset--) {
    if (readU32(archive, offset) !== 0x06054b50) continue;
    const commentLength = readU16(archive, offset + 20);
    if (offset + 22 + commentLength === archive.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return invalidArchive();

  const diskNumber = readU16(archive, eocdOffset + 4);
  const centralDisk = readU16(archive, eocdOffset + 6);
  const entriesOnDisk = readU16(archive, eocdOffset + 8);
  const entryCount = readU16(archive, eocdOffset + 10);
  const centralSize = readU32(archive, eocdOffset + 12);
  const centralOffset = readU32(archive, eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== 2 || entryCount !== 2) return invalidArchive();
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralSize !== eocdOffset) return invalidArchive();
  ensureRange(archive, centralOffset, centralSize, eocdOffset);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (readU32(archive, cursor, eocdOffset) !== 0x02014b50) return invalidArchive();
    const madeBy = readU16(archive, cursor + 4, eocdOffset);
    const versionNeeded = readU16(archive, cursor + 6, eocdOffset);
    const flags = readU16(archive, cursor + 8, eocdOffset);
    const method = readU16(archive, cursor + 10, eocdOffset);
    const checksum = readU32(archive, cursor + 16, eocdOffset);
    const compressedSize = readU32(archive, cursor + 20, eocdOffset);
    const uncompressedSize = readU32(archive, cursor + 24, eocdOffset);
    const nameLength = readU16(archive, cursor + 28, eocdOffset);
    const extraLength = readU16(archive, cursor + 30, eocdOffset);
    const commentLength = readU16(archive, cursor + 32, eocdOffset);
    const startDisk = readU16(archive, cursor + 34, eocdOffset);
    const externalAttributes = readU32(archive, cursor + 38, eocdOffset);
    const localOffset = readU32(archive, cursor + 42, eocdOffset);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    ensureRange(archive, cursor, recordLength, eocdOffset);
    if (commentLength !== 0 || startDisk !== 0 || versionNeeded > 45 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) return invalidArchive();
    if (compressedSize > MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES || uncompressedSize > MAX_AWS_CONNECTION_REPORT_JSON_BYTES) return invalidArchive();
    if (method !== 0 && method !== 8) return invalidArchive();
    const allowedFlags = 0x0008 | 0x0800 | (method === 8 ? 0x0006 : 0);
    if ((flags & ~allowedFlags) !== 0 || (externalAttributes & 0x10) !== 0) return invalidArchive();
    const operatingSystem = madeBy >>> 8;
    if (operatingSystem === 3 || operatingSystem === 19) {
      const fileType = (externalAttributes >>> 16) & 0xf000;
      if (fileType !== 0 && fileType !== 0x8000) return invalidArchive();
    }

    const nameOffset = cursor + 46;
    const name = decodeSafeJsonName(archive, nameOffset, nameLength);
    validateExtraFields(archive, nameOffset + nameLength, extraLength);
    if (entries.some((entry) => entry.name === name)) return invalidArchive();
    entries.push({ name, flags, method, checksum, compressedSize, uncompressedSize, localOffset, nameLength, versionNeeded, externalAttributes });
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) return invalidArchive();

  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if (ordered[0]?.localOffset !== 0) return invalidArchive();
  const extracted: Array<{ name: string; bytes: Buffer }> = [];
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!;
    const nextOffset = ordered[index + 1]?.localOffset ?? centralOffset;
    if (nextOffset <= entry.localOffset || readU32(archive, entry.localOffset, centralOffset) !== 0x04034b50) return invalidArchive();
    const localVersionNeeded = readU16(archive, entry.localOffset + 4, centralOffset);
    const localFlags = readU16(archive, entry.localOffset + 6, centralOffset);
    const localMethod = readU16(archive, entry.localOffset + 8, centralOffset);
    const localChecksum = readU32(archive, entry.localOffset + 14, centralOffset);
    const localCompressedSize = readU32(archive, entry.localOffset + 18, centralOffset);
    const localUncompressedSize = readU32(archive, entry.localOffset + 22, centralOffset);
    const localNameLength = readU16(archive, entry.localOffset + 26, centralOffset);
    const localExtraLength = readU16(archive, entry.localOffset + 28, centralOffset);
    if (localVersionNeeded !== entry.versionNeeded || localFlags !== entry.flags || localMethod !== entry.method || localNameLength !== entry.nameLength) return invalidArchive();
    const localNameOffset = entry.localOffset + 30;
    ensureRange(archive, localNameOffset, localNameLength + localExtraLength, centralOffset);
    const localName = decodeSafeJsonName(archive, localNameOffset, localNameLength);
    if (localName !== entry.name) return invalidArchive();
    validateExtraFields(archive, localNameOffset + localNameLength, localExtraLength);

    const hasDataDescriptor = (entry.flags & 0x0008) !== 0;
    if (hasDataDescriptor) {
      if ((localChecksum !== 0 && localChecksum !== entry.checksum) ||
          (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize) ||
          (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)) return invalidArchive();
    } else if (localChecksum !== entry.checksum || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) {
      return invalidArchive();
    }

    const dataOffset = localNameOffset + localNameLength + localExtraLength;
    ensureRange(archive, dataOffset, entry.compressedSize, nextOffset);
    const dataEnd = dataOffset + entry.compressedSize;
    let recordEnd = dataEnd;
    if (hasDataDescriptor) {
      let descriptorOffset = dataEnd;
      if (readU32(archive, descriptorOffset, nextOffset) === 0x08074b50) descriptorOffset += 4;
      if (readU32(archive, descriptorOffset, nextOffset) !== entry.checksum ||
          readU32(archive, descriptorOffset + 4, nextOffset) !== entry.compressedSize ||
          readU32(archive, descriptorOffset + 8, nextOffset) !== entry.uncompressedSize) return invalidArchive();
      recordEnd = descriptorOffset + 12;
    }
    if (recordEnd !== nextOffset) return invalidArchive();

    const compressed = archive.subarray(dataOffset, dataEnd);
    let bytes: Buffer;
    try {
      bytes = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_AWS_CONNECTION_REPORT_JSON_BYTES });
    } catch {
      return invalidArchive();
    }
    if (bytes.length !== entry.uncompressedSize || bytes.length > MAX_AWS_CONNECTION_REPORT_JSON_BYTES || crc32(bytes) !== entry.checksum) return invalidArchive();
    extracted.push({ name: entry.name, bytes });
  }
  return extracted;
}

function parseJsonMember(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalidArchive();
  }
  try {
    return parseStrictJson(text, MAX_AWS_CONNECTION_REPORT_JSON_BYTES, MAX_AWS_CONNECTION_REPORT_JSON_NODES);
  } catch {
    return invalidArchive();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSensitiveKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => {
    const singular = word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') ? word.slice(0, -1) : word;
    return SENSITIVE_KEY_WORDS.has(word) || SENSITIVE_KEY_WORDS.has(singular);
  });
}

function hasSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function hasSensitiveNumericValue(value: number): boolean {
  return /^\d{12}$/.test(String(value));
}

function safeStatusValue(value: string): boolean {
  return SAFE_STATUS_VALUES.has(value);
}

function safeReportString(key: string, value: string): boolean {
  if (key === 'observed_at_utc') return SAFE_ISO_TIMESTAMP.test(value);
  if (key === 'schema') return SAFE_REPORT_SCHEMA_VALUES.has(value);
  return AGGREGATE_STATUS_KEYS.has(key) && safeStatusValue(value);
}

function safeReceiptMetadata(receipt: Record<string, unknown>): boolean {
  return receipt.schema === AWS_CONNECTION_REPORT_ARTIFACT.receiptSchema &&
    receipt.report_file === AWS_CONNECTION_REPORT_ARTIFACT.reportFile &&
    receipt.retrieval === AWS_CONNECTION_REPORT_ARTIFACT.retrieval;
}

function analyzeReport(value: unknown, strictAggregation: boolean, depth = 0, key = ''): boolean {
  if (depth > 20) return false;
  if (hasSensitiveKey(key)) return false;
  if (Array.isArray(value)) {
    if (strictAggregation && (value.length !== 0 || !['errors', 'warnings'].includes(key))) return false;
    return value.every((entry) => analyzeReport(entry, strictAggregation, depth + 1, key));
  }
  if (isRecord(value)) {
    if (Object.keys(value).length > 256) return false;
    for (const [childKey, childValue] of Object.entries(value)) {
      if (hasSensitiveKey(childKey)) return false;
      const aggregateKey = AGGREGATE_CONTAINER_KEYS.has(childKey) || AGGREGATE_STATUS_KEYS.has(childKey) ||
        AGGREGATE_NUMBER_KEY.test(childKey) || AGGREGATE_BOOLEAN_KEY.test(childKey);
      if (strictAggregation && !aggregateKey) return false;
      if (!analyzeReport(childValue, strictAggregation, depth + 1, childKey)) return false;
    }
    return true;
  }
  if (typeof value === 'string') {
    return !hasSensitiveValue(value) && safeReportString(key, value);
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && AGGREGATE_NUMBER_KEY.test(key) && !hasSensitiveNumericValue(value);
  }
  if (typeof value === 'boolean') return AGGREGATE_BOOLEAN_KEY.test(key);
  if (value === null) return AGGREGATE_NUMBER_KEY.test(key) || AGGREGATE_STATUS_KEYS.has(key);
  return false;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) invalidArchive();
}

export function inspectAwsConnectionReportArchive(
  archive: Buffer,
  expectedSha256: string,
  trustedArchiveSha256: string,
): AwsConnectionReportArchiveInspection {
  try {
    if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES) return invalidArchive();
    const normalizedExpectedSha256 = normalizeSha256(expectedSha256);
    const normalizedTrustedSha256 = normalizeSha256(trustedArchiveSha256);
    const archiveSha256 = createHash('sha256').update(archive).digest('hex');
    if (archiveSha256 !== normalizedExpectedSha256 || archiveSha256 !== normalizedTrustedSha256) return invalidArchive();

    const members = extractJsonMembers(archive);
    const parsedMembers = members.map((member) => ({ ...member, value: parseJsonMember(member.bytes) }));
    const receiptCandidates = parsedMembers.filter((member) =>
      isRecord(member.value) && member.value.schema === AWS_CONNECTION_REPORT_ARTIFACT.receiptSchema);
    if (receiptCandidates.length !== 1 || parsedMembers.length !== 2) return invalidArchive();
    const receiptMember = receiptCandidates[0]!;
    if (!isRecord(receiptMember.value)) return invalidArchive();
    const receipt = receiptMember.value;
    requireExactKeys(receipt, ['schema', 'report_file', 'report_sha256', 'report_bytes', 'retrieval']);
    const reportMembers = parsedMembers.filter((member) => member !== receiptMember);
    if (reportMembers.length !== 1) return invalidArchive();
    const reportMember = reportMembers[0]!;

    if (receiptMember.name !== AWS_CONNECTION_REPORT_ARTIFACT.receiptFile ||
        receipt.report_file !== AWS_CONNECTION_REPORT_ARTIFACT.reportFile || reportMember.name !== AWS_CONNECTION_REPORT_ARTIFACT.reportFile ||
        typeof receipt.report_file !== 'string' ||
        typeof receipt.report_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(receipt.report_sha256) ||
        receipt.report_sha256.toLowerCase() !== createHash('sha256').update(reportMember.bytes).digest('hex') ||
        receipt.report_bytes !== reportMember.bytes.length) return invalidArchive();

    const aggregateOnly = analyzeReport(reportMember.value, true);
    const redactionPass = analyzeReport(reportMember.value, false) && safeReceiptMetadata(receipt);
    return {
      archiveBytes: archive.length,
      archiveDigestVerified: true,
      archiveDigestStatus: 'github_artifact_digest_verified',
      callerExpectedDigestMatch: true,
      aggregateOnly,
      redactionPass,
    };
  } catch {
    return invalidArchive();
  }
}
