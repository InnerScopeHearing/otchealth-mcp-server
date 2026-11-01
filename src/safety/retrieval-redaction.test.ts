import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExplicitSecretFieldName, redactExplicitSecretAssignments, sanitizeRetrievedPayload, sanitizeToolResult } from './retrieval-redaction.js';

test('redacts explicit secret assignments in common label spellings and indicates each redaction', () => {
  const input = [
    'Workspace secret: SYNTHETIC_SECRET_SENTINEL_01',
    'workspace_secret=SYNTHETIC_SECRET_SENTINEL_02',
    'workspaceSecret: SYNTHETIC_SECRET_SENTINEL_03',
    'client-secret = SYNTHETIC_SECRET_SENTINEL_04',
  ].join('\n');
  const output = redactExplicitSecretAssignments(input);
  assert.doesNotMatch(output, /SYNTHETIC_SECRET_SENTINEL/);
  assert.equal((output.match(/\[REDACTED: explicitly labeled secret\]/g) ?? []).length, 4);
  assert.match(output, /Workspace secret:/);
});

test('leaves ordinary prose intact when it mentions secrets without an assignment label', () => {
  const ordinary = 'The workspace secret belongs in the approved store. A secret is required for setup.';
  assert.equal(redactExplicitSecretAssignments(ordinary), ordinary);
  assert.equal(redactExplicitSecretAssignments('workspace secret belongs in approved storage.'), 'workspace secret belongs in approved storage.');
  assert.equal(isExplicitSecretFieldName('secretary'), false);
  assert.equal(isExplicitSecretFieldName('workspaceSecret'), true);
});

test('redacts a fictional token-like value after the workspace secret label without punctuation', () => {
  const sentinel = 'SYNTHETIC_TOKEN_9x7M2q8V4p6R3t1A';
  const output = redactExplicitSecretAssignments(`workspace secret ${sentinel}`);
  assert.equal(output, 'workspace secret [REDACTED: explicitly labeled secret]');
  assert.ok(!output.includes(sentinel));
});

test('redacts a secret value on the line after an empty assignment and preserves later prose', () => {
  const output = redactExplicitSecretAssignments('api_key:\nSYNTHETIC_NEXT_LINE_VALUE\nrotation status: complete');
  assert.doesNotMatch(output, /SYNTHETIC_NEXT_LINE_VALUE/);
  assert.match(output, /api_key:\[REDACTED: explicitly labeled secret\]/);
  assert.match(output, /rotation status: complete/);
});

test('an empty secret assignment leaves an obvious unindented sibling YAML key intact', () => {
  const output = redactExplicitSecretAssignments('api_key:\nstatus: active\ncount: 3');
  assert.match(output, /status: active/);
  assert.match(output, /count: 3/);
  assert.doesNotMatch(output, /status: \[REDACTED/);
});

test('redacts complete indented YAML block scalars without consuming the next sibling field', () => {
  const output = redactExplicitSecretAssignments([
    'api_key: |',
    '  SYNTHETIC_BLOCK_LINE_ONE',
    '  SYNTHETIC_BLOCK_LINE_TWO',
    'status: active',
  ].join('\n'));
  assert.doesNotMatch(output, /SYNTHETIC_BLOCK_LINE/);
  assert.match(output, /api_key:\s*\[REDACTED: explicitly labeled secret\]/);
  assert.match(output, /status: active/);
});

test('preserves benign numeric count metadata while redacting credential-like fields', () => {
  const output = sanitizeRetrievedPayload({
    token_count: 12,
    secret_count: 2,
    token_type: 'Bearer',
    token_status: 'active',
    secret_name: 'workspace-secret-parameter',
    api_key_name: 'integration-key',
    token: 'SYNTHETIC_CREDENTIAL_VALUE',
    text: 'workspace secret: SYNTHETIC_INLINE_VALUE',
  });
  assert.equal(output.token_count, 12);
  assert.equal(output.secret_count, 2);
  assert.equal(output.token_type, 'Bearer');
  assert.equal(output.token_status, 'active');
  assert.equal(output.secret_name, 'workspace-secret-parameter');
  assert.equal(output.api_key_name, 'integration-key');
  assert.equal(output.token, '[REDACTED: explicitly labeled secret]');
  assert.match(output.text, /\[REDACTED: explicitly labeled secret\]/);
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_/);
});

test('sanitizes labeled values echoed in search summaries and error messages', () => {
  const query = 'workspace secret SYNTHETIC_QUERY_VALUE';
  const error = 'upstream rejected api_key: SYNTHETIC_ERROR_VALUE';
  const output = sanitizeRetrievedPayload({
    data: { matches: [], error },
    summary: `Search failed for "${query}": ${error}`,
  });
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_(QUERY|ERROR)_VALUE/);
  assert.match(output.summary, /\[REDACTED: explicitly labeled secret\]/);
  assert.match(output.data.error, /\[REDACTED: explicitly labeled secret\]/);
});

test('whole tool-result sanitization covers quoted credentials in early-branch data and summary', () => {
  const earlyResult = sanitizeToolResult({
    data: { index: 'unknown "api_key=SYNTHETIC_QUOTED_INDEX_VALUE"', matches: [], count: 0, mode: 'unknown-index' },
    summary: 'Unknown index "api_key=SYNTHETIC_QUOTED_SUMMARY_VALUE".',
  });
  assert.doesNotMatch(JSON.stringify(earlyResult), /SYNTHETIC_QUOTED_/);
  assert.equal(earlyResult.data.count, 0);
  assert.equal(earlyResult.data.mode, 'unknown-index');
});

test('exact secret-labeled numeric values redact, booleans and nonsecret counts retain their type', () => {
  const output = sanitizeRetrievedPayload({ secret: 0, token: 7, api_key: true, password: false, token_count: 12, secret_count: 3 });
  assert.deepEqual(output, {
    secret: '[REDACTED: explicitly labeled secret]',
    token: '[REDACTED: explicitly labeled secret]',
    api_key: true,
    password: false,
    token_count: 12,
    secret_count: 3,
  });
  assert.equal(typeof output.api_key, 'boolean');
  assert.equal(typeof output.api_key, 'boolean');
});

test('sanitizes adjacent search matches while preserving citation and feedback references', () => {
  const output = sanitizeRetrievedPayload({
    index: 'synthetic-index',
    matches: [{ id: 'hit-1', text: 'workspace secret SYNTHETIC_ADJACENT_VALUE', feedback_ref: 'fb-1' }],
    citations: [{ n: 1, id: 'hit-1', source: 'synthetic-source' }],
    evidence_pack: { claimBindings: [{ claimId: 'claim-1', citationIds: ['hit-1'] }] },
  });
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_ADJACENT_VALUE/);
  assert.match(output.matches[0]!.text, /\[REDACTED: explicitly labeled secret\]/);
  assert.equal(output.matches[0]!.id, 'hit-1');
  assert.equal(output.matches[0]!.feedback_ref, 'fb-1');
  assert.deepEqual(output.citations[0], { n: 1, id: 'hit-1', source: 'synthetic-source' });
  assert.deepEqual(output.evidence_pack.claimBindings[0]!.citationIds, ['hit-1']);
});

test('sanitizes labeled text and fields while preserving IDs and citation metadata', () => {
  const source = {
    id: 'developer__20261101-001',
    text: 'Evidence: workspace_secret: SYNTHETIC_SECRET_SENTINEL_05',
    citations: [{ n: 1, id: 'doc-7', path: 'notes/source.md' }],
    entity_answer: { key: 'workspace secret', value: 'SYNTHETIC_SECRET_SENTINEL_06', id: 'entity-2' },
    ordinary: 'safe value',
  };
  const output = sanitizeRetrievedPayload(source);
  assert.equal(output.id, source.id);
  assert.equal(output.citations[0]!.n, 1);
  assert.equal(output.citations[0]!.id, 'doc-7');
  assert.equal(output.citations[0]!.path, 'notes/source.md');
  assert.equal(output.text, 'Evidence: workspace_secret: [REDACTED: explicitly labeled secret]');
  assert.equal(output.entity_answer.value, '[REDACTED: explicitly labeled secret]');
  assert.equal(output.entity_answer.id, 'entity-2');
  assert.equal(output.ordinary, 'safe value');
});
