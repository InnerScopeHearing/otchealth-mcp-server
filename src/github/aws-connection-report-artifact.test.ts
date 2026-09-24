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
const REPORT_FILE = 'aws-connection-report.json';
const RECEIPT_FILE = 'receipt.json';
const SYNTHETIC_GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;

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

const PRODUCER_REPORT_ROOT_KEYS = [
  'account',
  'cloudtrail_signin_metadata_last_hour',
  'ecs',
  'errors',
  'gateway_http',
  'neptune_stopper_alarm',
  'observed_at_utc',
  'opensearch',
  'rds',
  'region',
  'scope',
] as const;

const PRODUCER_SERVICE_KEYS = [
  'ecs',
  'gateway_http',
  'rds',
  'opensearch',
  'neptune_stopper_alarm',
  'cloudtrail_signin_metadata_last_hour',
] as const;

function makeProducerReport(): Record<string, unknown> {
  // Source contract: InnerScopeHearing/otchealth-cto/scripts/aws-connection-report.py.
  // Values are synthetic. The current producer includes identifiers and diagnostic text.
  return {
    observed_at_utc: '2026-09-24T12:00:00Z',
    account: 'ACCOUNT_FIXTURE_SENTINEL',
    region: 'REGION_FIXTURE_SENTINEL',
    scope: 'producer scope free text sentinel',
    ecs: { status: 'healthy', service_name: 'service-name-sentinel' },
    gateway_http: { healthy: true, readiness_message: 'gateway free text sentinel' },
    rds: { status: 'ok', resource_id: 'database-resource-sentinel' },
    opensearch: { status: 'ok', domain_name: 'domain-name-sentinel' },
    neptune_stopper_alarm: { status: 'ok', resource_arn: 'resource-arn-sentinel' },
    cloudtrail_signin_metadata_last_hour: {
      status: 'partial',
      events: [{ principal: 'principal-sentinel', detail: 'event free text sentinel' }],
    },
    errors: ['producer error free text sentinel'],
  };
}

function projectProducerReport(report: Record<string, unknown>): Record<string, unknown> {
  const statuses = PRODUCER_SERVICE_KEYS.map((key) => {
    const section = report[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) return 'unknown';
    if (key === 'gateway_http') {
      const healthy = (section as Record<string, unknown>).healthy;
      return healthy === true ? 'healthy' : healthy === false ? 'unhealthy' : 'unknown';
    }
    const status = (section as Record<string, unknown>).status;
    return typeof status === 'string' ? status : 'unknown';
  });
  const healthy = statuses.filter((status) => status === 'healthy' || status === 'ok').length;
  const failed = statuses.filter((status) => status === 'failed' || status === 'unhealthy' || status === 'error').length;
  return {
    observed_at_utc: report.observed_at_utc,
    summary: { checks: statuses.length, healthy, failed },
    ecs: { status: statuses[0] },
    gateway_http: { healthy: statuses[1] === 'healthy' },
    rds: { status: statuses[2] },
    opensearch: { status: statuses[3] },
    neptune_stopper_alarm: { status: statuses[4] },
    cloudtrail_signin_metadata_last_hour: { status: statuses[5] },
    errors: [],
  };
}

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...projectProducerReport(makeProducerReport()), ...overrides };
}

function makeArchive(
  report: Record<string, unknown>,
  receiptOverrides: Record<string, unknown> = {},
  reportFile = REPORT_FILE,
  receiptFile = RECEIPT_FILE,
): Buffer {
  const reportBytes = Buffer.from(JSON.stringify(report), 'utf8');
  const receipt = {
    schema: 'ai-os-aws-redacted-report-receipt-v1',
    report_file: reportFile,
    report_sha256: createHash('sha256').update(reportBytes).digest('hex'),
    report_bytes: reportBytes.length,
    retrieval: 'GitHub Actions artifact aws-connection-report, artifact file aws-report-artifact/aws-connection-report.json',
    ...receiptOverrides,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  return makeZip([
    { name: reportFile, data: reportBytes, method: 'deflate', dataDescriptor: true },
    { name: receiptFile, data: receiptBytes, method: 'deflate' },
  ]);
}

function makeBinding(overrides: Record<string, unknown> = {}): Parameters<typeof validateAwsConnectionReportArtifactBinding>[0] {
  const expectedSha256 = 'a'.repeat(64);
  const headSha = 'f'.repeat(40);
  const workflowRunBinding = {
    id: RUN_ID,
    repository_id: REPOSITORY_ID,
    head_repository_id: REPOSITORY_ID,
    head_branch: 'main',
    head_sha: headSha,
  };
  const runArtifact = {
    id: ARTIFACT_ID,
    name: AWS_CONNECTION_REPORT_ARTIFACT.name,
    digest: `sha256:${expectedSha256}`,
    workflow_run: workflowRunBinding,
  };
  const artifact = {
    id: ARTIFACT_ID,
    name: AWS_CONNECTION_REPORT_ARTIFACT.name,
    size_in_bytes: 512,
    expired: false,
    digest: `sha256:${expectedSha256}`,
    workflow_run: workflowRunBinding,
  };
  const fullName = `${AWS_CONNECTION_REPORT_ARTIFACT.owner}/${AWS_CONNECTION_REPORT_ARTIFACT.repo}`;
  return {
    owner: AWS_CONNECTION_REPORT_ARTIFACT.owner,
    repo: AWS_CONNECTION_REPORT_ARTIFACT.repo,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
    expectedSha256,
    repository: { id: REPOSITORY_ID, full_name: fullName },
    run: {
      id: RUN_ID,
      name: 'aws-health-monitor',
      path: AWS_CONNECTION_REPORT_ARTIFACT.workflowPath,
      event: 'schedule',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: headSha,
      repository: { id: REPOSITORY_ID, full_name: fullName },
      head_repository: { id: REPOSITORY_ID, full_name: fullName },
    },
    runArtifacts: [runArtifact],
    artifact,
    ...overrides,
  };
}

test('validates exact repository, run, artifact, name, digest, and bounded metadata before download', () => {
  const result = validateAwsConnectionReportArtifactBinding(makeBinding());
  assert.equal(result.archiveSizeBytes, 512);
  assert.equal(result.expectedSha256, 'a'.repeat(64));
  assert.equal(result.trustedArchiveSha256, 'a'.repeat(64));
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

test('rejects artifacts unless the trusted producer workflow and successful main run are bound exactly', () => {
  const baseRun = makeBinding().run as Record<string, unknown>;
  const baseArtifact = makeBinding().artifact as Record<string, unknown>;
  const workflowBinding = (baseArtifact.workflow_run as Record<string, unknown>);
  const cases = [
    makeBinding({ run: { ...baseRun, path: '.github/workflows/unapproved.yml@refs/heads/main' } }),
    makeBinding({ run: { ...baseRun, head_repository: { id: REPOSITORY_ID + 1, full_name: 'other/repo' } } }),
    makeBinding({ run: { ...baseRun, head_branch: 'feature/untrusted' } }),
    makeBinding({ run: { ...baseRun, path: '.github/workflows/aws-health-monitor.yml@refs/heads/release' } }),
    makeBinding({ run: { ...baseRun, event: 'pull_request' } }),
    makeBinding({ run: { ...baseRun, status: 'in_progress', conclusion: null } }),
    makeBinding({ run: { ...baseRun, status: 'completed', conclusion: 'failure' } }),
    makeBinding({
      artifact: {
        ...baseArtifact,
        workflow_run: { ...workflowBinding, head_sha: 'e'.repeat(40) },
      },
    }),
  ];
  for (const binding of cases) {
    assert.throws(() => validateAwsConnectionReportArtifactBinding(binding), /artifact provenance is invalid/);
  }
});

test('requires the GitHub artifact digest and rejects caller-only archive verification', () => {
  const archive = makeArchive(makeReport());
  const callerExpectedSha256 = createHash('sha256').update(archive).digest('hex');
  assert.throws(
    () => inspectAwsConnectionReportArchive(archive, callerExpectedSha256, undefined as unknown as string),
    /archive verification failed/,
  );

  const apiDigestResult = inspectAwsConnectionReportArchive(archive, callerExpectedSha256, callerExpectedSha256);
  assert.equal(apiDigestResult.archiveDigestVerified, true);
  assert.equal(apiDigestResult.archiveDigestStatus, 'github_artifact_digest_verified');

  const base = makeBinding();
  const bindingWithoutListDigest = makeBinding({
    runArtifacts: [{ ...(base.runArtifacts as Record<string, unknown>[])[0], digest: undefined }],
  });
  assert.throws(() => validateAwsConnectionReportArtifactBinding(bindingWithoutListDigest), /artifact provenance is invalid/);

  const bindingWithMismatchingListDigest = makeBinding({
    runArtifacts: [{ ...(base.runArtifacts as Record<string, unknown>[])[0], digest: `sha256:${'b'.repeat(64)}` }],
  });
  assert.throws(() => validateAwsConnectionReportArtifactBinding(bindingWithMismatchingListDigest), /artifact provenance is invalid/);

  const bindingWithoutDetailDigest = makeBinding({
    artifact: { ...(makeBinding().artifact as object), digest: undefined },
  });
  assert.throws(() => validateAwsConnectionReportArtifactBinding(bindingWithoutDetailDigest), /artifact provenance is invalid/);
});

test('accepts only the safe aggregate projection of the producer report contract', () => {
  const producerReport = makeProducerReport();
  assert.deepEqual(Object.keys(producerReport).sort(), [...PRODUCER_REPORT_ROOT_KEYS].sort());

  const rawArchive = makeArchive(producerReport);
  const rawDigest = createHash('sha256').update(rawArchive).digest('hex');
  const rawResult = inspectAwsConnectionReportArchive(rawArchive, rawDigest, rawDigest);
  assert.equal(rawResult.aggregateOnly, false);
  assert.equal(rawResult.redactionPass, false);

  const projection = projectProducerReport(producerReport);
  const projectionJson = JSON.stringify(projection);
  assert.deepEqual(Object.keys(projection).sort(), [
    'cloudtrail_signin_metadata_last_hour',
    'ecs',
    'errors',
    'gateway_http',
    'neptune_stopper_alarm',
    'observed_at_utc',
    'opensearch',
    'rds',
    'summary',
  ].sort());
  for (const sentinel of [
    'ACCOUNT_FIXTURE_SENTINEL',
    'REGION_FIXTURE_SENTINEL',
    'service-name-sentinel',
    'gateway free text sentinel',
    'producer error free text sentinel',
  ]) {
    assert.equal(projectionJson.includes(sentinel), false);
  }

  const archive = makeArchive(projection);
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
  assert.deepEqual(result, {
    archiveBytes: archive.length,
    archiveDigestVerified: true,
    archiveDigestStatus: 'github_artifact_digest_verified',
    callerExpectedDigestMatch: true,
    aggregateOnly: true,
    redactionPass: true,
  });
});

test('rejects a numeric account-like identifier hidden under a broad aggregate count key', () => {
  const numericAccountSentinel = 999999999999;
  const archive = makeArchive(makeReport({
    summary: { checks: numericAccountSentinel, healthy: 1, failed: 0 },
  }));
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
  assert.equal(result.aggregateOnly, false);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes(String(numericAccountSentinel)), false);
});

test('verifies a bounded archive digest and returns only aggregate and redaction results', () => {
  const archive = makeArchive(makeReport());
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
  assert.deepEqual(result, {
    archiveBytes: archive.length,
    archiveDigestVerified: true,
    archiveDigestStatus: 'github_artifact_digest_verified',
    callerExpectedDigestMatch: true,
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
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
  assert.equal(result.aggregateOnly, false);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(JSON.stringify(result).includes('resource-name-sentinel'), false);
});

test('returns policy failures for a bounded detailed report instead of surfacing its rows', () => {
  const archive = makeArchive(makeReport({ resources: Array.from({ length: 5000 }, () => ({ status: 'healthy' })) }));
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
  assert.equal(result.aggregateOnly, false);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes('resources'), false);
});

test('requires exact receipt retrieval metadata and rejects credential-shaped schema, filename, and status values', () => {
  const cases = [
    makeArchive(makeReport({ schema: SYNTHETIC_GITHUB_TOKEN })),
    makeArchive(makeReport(), { retrieval: SYNTHETIC_GITHUB_TOKEN }),
    makeArchive(makeReport({ state: SYNTHETIC_GITHUB_TOKEN })),
    makeArchive(makeReport({ state: 'ok ' })),
  ];
  for (const archive of cases) {
    const expectedSha256 = createHash('sha256').update(archive).digest('hex');
    const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
    assert.equal(result.redactionPass, false);
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_GITHUB_TOKEN), false);
  }
  const unsafeFilenameArchive = makeArchive(makeReport(), {}, `${SYNTHETIC_GITHUB_TOKEN}.json`);
  const unsafeFilenameDigest = createHash('sha256').update(unsafeFilenameArchive).digest('hex');
  assert.throws(
    () => inspectAwsConnectionReportArchive(unsafeFilenameArchive, unsafeFilenameDigest, unsafeFilenameDigest),
    (error: unknown) => error instanceof Error && /archive verification failed/.test(error.message) &&
      !error.message.includes(SYNTHETIC_GITHUB_TOKEN),
  );
  const unsafeReceiptSchemaArchive = makeArchive(makeReport(), { schema: SYNTHETIC_GITHUB_TOKEN });
  const unsafeReceiptSchemaDigest = createHash('sha256').update(unsafeReceiptSchemaArchive).digest('hex');
  assert.throws(
    () => inspectAwsConnectionReportArchive(unsafeReceiptSchemaArchive, unsafeReceiptSchemaDigest, unsafeReceiptSchemaDigest),
    (error: unknown) => error instanceof Error && /archive verification failed/.test(error.message) &&
      !error.message.includes(SYNTHETIC_GITHUB_TOKEN),
  );
  const unsafeReceiptFilenameArchive = makeArchive(makeReport(), {}, REPORT_FILE, `${SYNTHETIC_GITHUB_TOKEN}.json`);
  const unsafeReceiptFilenameDigest = createHash('sha256').update(unsafeReceiptFilenameArchive).digest('hex');
  assert.throws(
    () => inspectAwsConnectionReportArchive(unsafeReceiptFilenameArchive, unsafeReceiptFilenameDigest, unsafeReceiptFilenameDigest),
    (error: unknown) => error instanceof Error && /archive verification failed/.test(error.message) &&
      !error.message.includes(SYNTHETIC_GITHUB_TOKEN),
  );
});

test('reports receipt redaction failure without surfacing path-like retrieval metadata', () => {
  const archive = makeArchive(makeReport(), { retrieval: 's3://fixture/path' });
  const expectedSha256 = createHash('sha256').update(archive).digest('hex');
  const result = inspectAwsConnectionReportArchive(archive, expectedSha256, expectedSha256);
  assert.equal(result.aggregateOnly, true);
  assert.equal(result.redactionPass, false);
  assert.equal(JSON.stringify(result).includes('s3://fixture/path'), false);
});

test('rejects archive digest mismatch, malformed receipt binding, unsafe member paths, and oversized archives', () => {
  const good = makeArchive(makeReport());
  const goodDigest = createHash('sha256').update(good).digest('hex');
  assert.throws(() => inspectAwsConnectionReportArchive(good, 'b'.repeat(64), goodDigest), /archive verification failed/);
  const badReceipt = makeArchive(makeReport(), { report_sha256: 'f'.repeat(64) });
  const badReceiptHash = createHash('sha256').update(badReceipt).digest('hex');
  assert.throws(() => inspectAwsConnectionReportArchive(badReceipt, badReceiptHash, badReceiptHash), /archive verification failed/);
  const traversal = makeZip([
    { name: '../report.json', data: Buffer.from('{}') },
    { name: RECEIPT_FILE, data: Buffer.from('{}') },
  ]);
  const traversalDigest = createHash('sha256').update(traversal).digest('hex');
  assert.throws(() => inspectAwsConnectionReportArchive(traversal, traversalDigest, traversalDigest), /archive verification failed/);
  const oversized = Buffer.alloc(MAX_AWS_CONNECTION_REPORT_ARCHIVE_BYTES + 1);
  assert.throws(() => inspectAwsConnectionReportArchive(oversized, 'a'.repeat(64), 'a'.repeat(64)), /archive verification failed/);
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
