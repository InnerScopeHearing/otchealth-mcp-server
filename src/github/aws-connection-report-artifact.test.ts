import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  AWS_CONNECTION_REPORT_ARTIFACT,
  MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES,
  inspectAwsConnectionReportArchive,
  validateAwsConnectionReportArtifactBinding,
  validateGitHubActionsArtifactDownloadUrl,
} from './aws-connection-report-artifact.js';

const REPOSITORY_ID = 23456;
const RUN_ID = 9001;
const ARTIFACT_ID = 7002;
const REPORT_FILE = 'report.json';
const RECEIPT_FILE = 'receipt.json';

type ZipMember = { name: string; data: Buffer; method?: 'store' | 'deflate'; dataDescriptor?: boolean; externalAttributes?: number };

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(members: ZipMember[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const method = member.method === 'deflate' ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(member.data) : member.data;
    const checksum = crc32(member.data);
    const flags = member.dataDescriptor ? 0x0008 : 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(member.dataDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(member.dataDescriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(member.dataDescriptor ? 0 : member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);
    let descriptorLength = 0;
    if (member.dataDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(member.data.length, 12);
      localParts.push(descriptor);
      descriptorLength = descriptor.length;
    }
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(member.externalAttributes ?? 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length + descriptorLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observed_at_utc: '2026-09-24T12:00:00Z',
    scope: { status: 'complete' },
    summary: { checks: 2, healthy: 2, failed: 0 },
    errors: [],
    ...overrides,
  };
}

function makeArchive(report: Record<string, unknown>, receiptOverrides: Record<string, unknown> = {}): Buffer {
  const reportBytes = Buffer.from(JSON.stringify(report), 'utf8');
  const receipt = {
    schema: 'ai-os-aws-redacted-report-receipt-v1',
    report_file: REPORT_FILE,
    report_sha256: createHash('sha256').update(reportBytes).digest('hex'),
    report_bytes: reportBytes.length,
    retrieval: 'workflow-artifact',
    ...receiptOverrides,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  return makeZip([
    { name: REPORT_FILE, data: reportBytes, method: 'deflate', dataDescriptor: true },
    { name: RECEIPT_FILE, data: receiptBytes, method: 'deflate' },
  ]);
}

function makeBinding(overrides: Record<string, unknown> = {}): Parameters<typeof validateAwsConnectionReportArtifactBinding>[0] {
  const expectedSha256 = 'a'.repeat(64);
  const runArtifact = { id: ARTIFACT_ID, name: AWS_CONNECTION_REPORT_ARTIFACT.name };
  const artifact = {
    id: ARTIFACT_ID,
    name: AWS_CONNECTION_REPORT_ARTIFACT.name,
    size_in_bytes: 512,
    expired: false,
    digest: `sha256:${expectedSha256}`,
    workflow_run: { id: RUN_ID, repository_id: REPOSITORY_ID },
  };
  return {
    owner: AWS_CONNECTION_REPORT_ARTIFACT.owner,
    repo: AWS_CONNECTION_REPORT_ARTIFACT.repo,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
    expectedSha256,
    repository: { id: REPOSITORY_ID, full_name: `${AWS_CONNECTION_REPORT_ARTIFACT.owner}/${AWS_CONNECTION_REPORT_ARTIFACT.repo}` },
    run: { id: RUN_ID, repository: { id: REPOSITORY_ID, full_name: `${AWS_CONNECTION_REPORT_ARTIFACT.owner}/${AWS_CONNECTION_REPORT_ARTIFACT.repo}` } },
    runArtifacts: [runArtifact],
    artifact,
    ...overrides,
  };
}

test('validates exact repository, run, artifact, name, digest, and bounded metadata before download', () => {
  const result = validateAwsConnectionReportArtifactBinding(makeBinding());
  assert.equal(result.archiveSizeBytes, 512);
  assert.equal(result.expectedSha256, 'a'.repeat(64));
});

test('rejects repository, run, membership, artifact, digest, expiry, and size mismatches generically', () => {
  const cases = [
    makeBinding({ owner: 'other-owner' }),
    makeBinding({ repo: 'other-repo' }),
    makeBinding({ run: { id: RUN_ID + 1, repository: { id: REPOSITORY_ID, full_name: `${AWS_CONNECTION_REPORT_ARTIFACT.owner}/${AWS_CONNECTION_REPORT_ARTIFACT.repo}` } } }),
    makeBinding({ runArtifacts: [] }),
    makeBinding({ artifact: { ...(makeBinding().artifact as object), id: ARTIFACT_ID + 1 } }),
    makeBinding({ artifact: { ...(makeBinding().artifact as object), name: 'other-artifact' } }),
    makeBinding({ artifact: { ...(makeBinding().artifact as object), workflow_run: { id: RUN_ID + 1, repository_id: REPOSITORY_ID } } }),
    makeBinding({ artifact: { ...(makeBinding().artifact as object), digest: `sha256:${'b'.repeat(64)}` } }),
    makeBinding({ artifact: { ...(makeBinding().artifact as object), expired: true } }),
    makeBinding({ artifact: { ...(makeBinding().artifact as object), size_in_bytes: MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES + 1 } }),
  ];
  for (const binding of cases) {
    assert.throws(() => validateAwsConnectionReportArtifactBinding(binding), /artifact provenance is invalid/);
  }
});

test('verifies a bounded archive digest and returns only aggregate and redaction results', () => {
  const archive = makeArchive(makeReport());
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256);
  assert.deepEqual(result, {
    archiveBytes: archive.length,
    archiveDigestVerified: true,
    aggregateOnly: true,
    redactionPass: true,
  });
});

test('fails closed on account identifiers and resource detail without returning their values', () => {
  const sentinel = 'SENSITIVE_FIXTURE_SENTINEL_999999999999';
  const archive = makeArchive(makeReport({
    account_number: sentinel,
    resources: [{ resource_name: 'resource-name-sentinel' }],
  }));
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256);
  assert.equal(result.aggregateOnly, false);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(JSON.stringify(result).includes('resource-name-sentinel'), false);
});

test('returns policy failures for a bounded detailed report instead of surfacing its rows', () => {
  const archive = makeArchive(makeReport({ resources: Array.from({ length: 5000 }, () => ({ status: 'healthy' })) }));
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256);
  assert.equal(result.aggregateOnly, false);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes('resources'), false);
});

test('reports receipt redaction failure without surfacing path-like retrieval metadata', () => {
  const archive = makeArchive(makeReport(), { retrieval: 's3://fixture/path' });
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256);
  assert.equal(result.aggregateOnly, true);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes('s3://fixture/path'), false);
});

test('rejects archive digest mismatch, malformed receipt binding, unsafe member paths, and oversized archives', () => {
  const good = makeArchive(makeReport());
  assert.throws(() => inspectAwsConnectionReportArchive(good, 'b'.repeat(64)), /archive verification failed/);
  const badReceipt = makeArchive(makeReport(), { report_sha256: 'f'.repeat(64) });
  const badReceiptHash = createHash('sha256').update(badReceipt).digest('hex');
  assert.throws(() => inspectAwsConnectionReportArchive(badReceipt, badReceiptHash), /archive verification failed/);
  const traversal = makeZip([
    { name: '../report.json', data: Buffer.from('{}') },
    { name: RECEIPT_FILE, data: Buffer.from('{}') },
  ]);
  assert.throws(() => inspectAwsConnectionReportArchive(traversal, createHash('sha256').update(traversal).digest('hex')), /archive verification failed/);
  const oversized = Buffer.alloc(MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES + 1);
  assert.throws(() => inspectAwsConnectionReportArchive(oversized, 'a'.repeat(64)), /archive verification failed/);
});

test('accepts only HTTPS artifact storage redirects on fixed hosts and paths', () => {
  assert.equal(new URL(validateGitHubActionsArtifactDownloadUrl('https://pipelines.actions.githubusercontent.com/download?sig=fixture')).hostname,
    'pipelines.actions.githubusercontent.com');
  assert.equal(new URL(validateGitHubActionsArtifactDownloadUrl('https://productionresultssa0.blob.core.windows.net/actions-results/archive.zip?sig=fixture')).hostname,
    'productionresultssa0.blob.core.windows.net');
  for (const url of [
    'http://pipelines.actions.githubusercontent.com/download?sig=fixture',
    'https://evil.example/actions-results/archive.zip?sig=fixture',
    'https://productionresultssa0.blob.core.windows.net/other/archive.zip?sig=fixture',
    'https://user@pipelines.actions.githubusercontent.com/download?sig=fixture',
  ]) {
    assert.throws(() => validateGitHubActionsArtifactDownloadUrl(url), /artifact redirect is invalid/);
  }
});
