import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

let extractJobLogText: typeof import('./workflow-job-log-failure-evidence.js').extractJobLogText;
let summarizeFailureEvidence: typeof import('./workflow-job-log-failure-evidence.js').summarizeFailureEvidence;
let assertFailureEvidenceRepoAllowed: typeof import('./workflow-job-log-failure-evidence.js').assertFailureEvidenceRepoAllowed;
let verifyFailureJobMetadata: typeof import('./workflow-job-log-failure-evidence.js').verifyFailureJobMetadata;
let safeFailureEvidenceError: typeof import('./workflow-job-log-failure-evidence.js').safeFailureEvidenceError;
let requiredRoleFor: typeof import('../../catalog/governance.js').requiredRoleFor;
let roleAllows: typeof import('../../catalog/governance.js').roleAllows;
let CTO_SHIP_LANE_TOOLSET: typeof import('../registry.js').CTO_SHIP_LANE_TOOLSET;

before(async () => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
  ({ extractJobLogText, summarizeFailureEvidence, assertFailureEvidenceRepoAllowed, verifyFailureJobMetadata, safeFailureEvidenceError } = await import('./workflow-job-log-failure-evidence.js'));
  ({ requiredRoleFor, roleAllows } = await import('../../catalog/governance.js'));
  ({ CTO_SHIP_LANE_TOOLSET } = await import('../registry.js'));
});

function makeZip(name: string, text: string, deflated = true): Uint8Array {
  const nameBytes = Buffer.from(name);
  const plain = Buffer.from(text);
  const data = deflated ? deflateRawSync(plain) : plain;
  const header = Buffer.alloc(30 + nameBytes.byteLength);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(deflated ? 8 : 0, 8);
  header.writeUInt32LE(data.byteLength, 18);
  header.writeUInt32LE(plain.byteLength, 22);
  header.writeUInt16LE(nameBytes.byteLength, 26);
  nameBytes.copy(header, 30);
  return Buffer.concat([header, data]);
}

test('ZIP extraction is bounded and supports deflate without returning archive/source metadata', () => {
  const archive = makeZip('job.txt', 'first\nERROR password=secret\nlast\n');
  const extracted = extractJobLogText(archive);
  assert.match(extracted, /password=secret/);
  assert.notEqual(extracted, archive.toString());
});

test('classification summary enforces line window and returns only fixed categories/counters', () => {
  const result = summarizeFailureEvidence('a\nsecret=abc\nthird\nfourth', 2, 2);
  assert.equal(result.failure_category, 'unknown_failure');
  assert.equal(result.total_lines, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.signal_count, 0);
  assert.equal(result.error_count, 0);
});

test('synthetic log signals classify only into the finite category enum', () => {
  const cases = [
    ['tests failed: assertion', 'test_failure'],
    ['build failed: compilation failed', 'build_failure'],
    ['npm dependency package not found', 'dependency_failure'],
    ['deadline exceeded', 'timeout'],
    ['permission denied', 'permission_failure'],
    ['network connection refused', 'network_failure'],
  ] as const;
  for (const [text, category] of cases) assert.equal(summarizeFailureEvidence(text).failure_category, category);
});

test('malformed and oversized archive members fail closed', () => {
  assert.throws(() => extractJobLogText(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), /archive|text member/i);
  assert.throws(() => extractJobLogText(makeZip('job.log', 'x'.repeat(2 * 1024 * 1024 + 1))), /bounded/i);
});

test('failure-evidence tool is CTO-only and visible on the CTO callable registry', () => {
  const gov = requiredRoleFor('github_workflow_job_log_failure_evidence');
  assert.ok(gov);
  assert.equal(roleAllows(gov!.role, 'cto'), true);
  for (const lane of ['developer', 'cfo', 'clo', 'coo', 'cro', '']) assert.equal(roleAllows(gov!.role, lane), false);
  assert.ok(CTO_SHIP_LANE_TOOLSET.includes('github_workflow_run_list_artifacts'));
  assert.ok(CTO_SHIP_LANE_TOOLSET.includes('github_workflow_job_log_failure_evidence'));
});

test('exact repository allowlist refuses other, PHI-ring, and MedReview repositories before requests', () => {
  assert.doesNotThrow(() => assertFailureEvidenceRepoAllowed('InnerScopeHearing', 'otchealth-mcp-server'));
  for (const repo of [
    ['InnerScopeHearing', 'other-repo'],
    ['InnerScopeHearing', 'medreview-production'],
    ['other-owner', 'otchealth-mcp-server'],
  ]) assert.throws(() => assertFailureEvidenceRepoAllowed(repo[0], repo[1]), /unavailable|repository/i);
});

test('metadata fence refuses run/job mismatch and completed success jobs', () => {
  assert.throws(() => verifyFailureJobMetadata([{ id: 8, status: 'completed', conclusion: 'failure' }], 9), /not part/i);
  assert.throws(() => verifyFailureJobMetadata([{ id: 8, status: 'completed', conclusion: 'success' }], 8), /completed failed/i);
  assert.equal(verifyFailureJobMetadata([{ id: 8, status: 'completed', conclusion: 'failure', name: 'test' }], 8).id, 8);
});

test('classification and remote errors never expose sentinel source/log/secret values', () => {
  const upstream = new Error('https://signed.example/log.zip?token=ghp_secret');
  const metadataError = safeFailureEvidenceError(upstream, 'metadata');
  const logError = safeFailureEvidenceError(upstream, 'log');
  for (const error of [metadataError, logError]) {
    assert.doesNotMatch(error.message, /signed|ghp_|token=|zip/i);
    assert.doesNotMatch(error.nextStep, /signed|ghp_|token=|zip/i);
  }
  const evidence = summarizeFailureEvidence('archive-secret=ghp_secret\nsource-name=private.log', 1, 2);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /ghp_secret|private\.log|archive-secret=ghp_secret/);
  assert.match(serialized, /unknown_failure|failure_category/);
});
