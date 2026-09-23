import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

let extractJobLogText: typeof import('./workflow-job-log-failure-evidence.js').extractJobLogText;
let sanitizeLogLine: typeof import('./workflow-job-log-failure-evidence.js').sanitizeLogLine;
let summarizeFailureEvidence: typeof import('./workflow-job-log-failure-evidence.js').summarizeFailureEvidence;
let assertFailureEvidenceRepoAllowed: typeof import('./workflow-job-log-failure-evidence.js').assertFailureEvidenceRepoAllowed;
let verifyFailureJobMetadata: typeof import('./workflow-job-log-failure-evidence.js').verifyFailureJobMetadata;
let safeFailureEvidenceError: typeof import('./workflow-job-log-failure-evidence.js').safeFailureEvidenceError;
let WITHHELD_SOURCE_FILE: typeof import('./workflow-job-log-failure-evidence.js').WITHHELD_SOURCE_FILE;
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
  ({ extractJobLogText, sanitizeLogLine, summarizeFailureEvidence, assertFailureEvidenceRepoAllowed, verifyFailureJobMetadata, safeFailureEvidenceError, WITHHELD_SOURCE_FILE } = await import('./workflow-job-log-failure-evidence.js'));
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

test('sanitization removes URLs, auth/header values, secret-shaped tokens and control bytes', () => {
  const result = sanitizeLogLine('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789 https://example.test/x?token=secret\u0001');
  assert.doesNotMatch(result.line, /ghp_|https?:\/\//i);
  assert.doesNotMatch(result.line, /Bearer\s+ghp_/i);
  assert.ok(result.redactions >= 2);
});

test('ZIP extraction is bounded, supports deflate and never exposes archive bytes', () => {
  const archive = makeZip('job.txt', 'first\nERROR password=secret\nlast\n');
  const extracted = extractJobLogText(archive);
  assert.equal(extracted.source_file, 'job.txt');
  assert.match(extracted.text, /password=secret/);
  assert.notEqual(extracted.text, archive.toString());
});

test('summary enforces line window and reports truncation/redaction', () => {
  const result = summarizeFailureEvidence('a\nsecret=abc\nthird\nfourth', 2, 2);
  assert.deepEqual(result.lines, ['secret=[redacted]', 'third']);
  assert.equal(result.total_lines, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.redacted_count, 1);
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

test('remote metadata and log errors are bounded and cannot echo secrets or archive/source names', () => {
  const upstream = new Error('https://signed.example/log.zip?token=ghp_secret');
  const metadataError = safeFailureEvidenceError(upstream, 'metadata');
  const logError = safeFailureEvidenceError(upstream, 'log');
  for (const error of [metadataError, logError]) {
    assert.doesNotMatch(error.message, /signed|ghp_|token=|zip/i);
    assert.doesNotMatch(error.nextStep, /signed|ghp_|token=|zip/i);
  }
  assert.equal(WITHHELD_SOURCE_FILE, '[withheld]');
  const evidence = summarizeFailureEvidence('archive-secret=ghp_secret\nsource-name=private.log', 1, 2);
  evidence.source_file = WITHHELD_SOURCE_FILE;
  assert.equal(evidence.source_file, '[withheld]');
  assert.doesNotMatch(JSON.stringify(evidence), /ghp_secret|archive-secret=ghp_secret/);
});
