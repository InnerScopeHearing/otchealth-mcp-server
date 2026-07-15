import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAutoJournalMode,
  isPrivilegedOrLegalTool,
  looksLikeSecretValue,
  redactArgs,
  buildEpisodeText,
  extractArtifactHint,
  safeAgentForJournal,
  SECRET_KEY_PATTERN,
  MAX_VALUE_CHARS,
  MAX_TOTAL_CHARS,
} from './journal.js';

// ---- parseAutoJournalMode -------------------------------------------------------------------------

test('parseAutoJournalMode: "off" parses to off, case-insensitive and trimmed', () => {
  assert.equal(parseAutoJournalMode('off'), 'off');
  assert.equal(parseAutoJournalMode('OFF'), 'off');
  assert.equal(parseAutoJournalMode('  Off  '), 'off');
});

test('parseAutoJournalMode: unset, garbage, or "on" all default to on', () => {
  assert.equal(parseAutoJournalMode(undefined), 'on');
  assert.equal(parseAutoJournalMode(''), 'on');
  assert.equal(parseAutoJournalMode('on'), 'on');
  assert.equal(parseAutoJournalMode('banana'), 'on');
});

// ---- isPrivilegedOrLegalTool -----------------------------------------------------------------------

test('isPrivilegedOrLegalTool: legal_* tools match', () => {
  assert.equal(isPrivilegedOrLegalTool('legal_blob_get'), true);
  assert.equal(isPrivilegedOrLegalTool('legal_blob_list'), true);
  assert.equal(isPrivilegedOrLegalTool('legal_blob_put'), true);
});

test('isPrivilegedOrLegalTool: any tool name containing "privileged" matches', () => {
  assert.equal(isPrivilegedOrLegalTool('kb_search_privileged'), true);
});

test('isPrivilegedOrLegalTool: case-insensitive', () => {
  assert.equal(isPrivilegedOrLegalTool('LEGAL_BLOB_GET'), true);
  assert.equal(isPrivilegedOrLegalTool('KB_SEARCH_PRIVILEGED'), true);
});

test('isPrivilegedOrLegalTool: an ordinary tool name does not match', () => {
  assert.equal(isPrivilegedOrLegalTool('memory_write'), false);
  assert.equal(isPrivilegedOrLegalTool('github_push_files'), false);
  assert.equal(isPrivilegedOrLegalTool('checkpoint'), false);
});

// ---- looksLikeSecretValue --------------------------------------------------------------------------

test('looksLikeSecretValue: a PEM private-key block is detected', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIC...fakekeycontent...\n-----END PRIVATE KEY-----';
  assert.equal(looksLikeSecretValue(pem), true);
});

test('looksLikeSecretValue: a JWT-shaped three-segment string is detected', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(looksLikeSecretValue(jwt), true);
});

test('looksLikeSecretValue: a long base64-shaped run is detected', () => {
  const blob = 'A'.repeat(90) + '==';
  assert.equal(looksLikeSecretValue(blob), true);
});

test('looksLikeSecretValue: an ordinary short string is not flagged', () => {
  assert.equal(looksLikeSecretValue('hello world'), false);
  assert.equal(looksLikeSecretValue('feat(memory): capture plane'), false);
  assert.equal(looksLikeSecretValue(''), false);
});

// ---- redactArgs -------------------------------------------------------------------------------------

test('redactArgs: a key matching SECRET_KEY_PATTERN (token/api_key) is removed', () => {
  const out = redactArgs('some_tool', { api_key: 'sk_live_abcdefghijklmnop', token: 'xyz123', normal: 'hello' });
  assert.equal(out !== null, true);
  assert.equal(out!.api_key, '[REDACTED]');
  assert.equal(out!.token, '[REDACTED]');
});

test('redactArgs: a normal arg survives untouched', () => {
  const out = redactArgs('some_tool', { title: 'ship the PR', count: 3, ok: true });
  assert.deepEqual(out, { title: 'ship the PR', count: 3, ok: true });
});

test('redactArgs: a PEM-shaped VALUE is redacted even under an innocuous key name', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIC...fakekeycontent...\n-----END PRIVATE KEY-----';
  const out = redactArgs('some_tool', { notes: pem });
  assert.equal(out!.notes, '[REDACTED]');
});

test('redactArgs: SECRET_KEY_PATTERN matches every key family named in the security law', () => {
  const dangerousKeys = [
    'secret', 'token', 'password', 'passwd', 'pwd', 'api_key', 'apiKey', 'credential',
    'authorization', 'auth', 'bearer', 'private_key', 'privateKey', 'p8', 'refresh',
    'client_secret', 'sas', 'connection_string',
  ];
  for (const k of dangerousKeys) {
    assert.ok(SECRET_KEY_PATTERN.test(k), `expected SECRET_KEY_PATTERN to match "${k}"`);
  }
});

test('redactArgs: nested object keys are also redacted (defense in depth beyond top level)', () => {
  const out = redactArgs('some_tool', { headers: { Authorization: 'Bearer abc123', 'x-request-id': 'r-1' } });
  const headers = out!.headers as Record<string, unknown>;
  assert.equal(headers.Authorization, '[REDACTED]');
  assert.equal(headers['x-request-id'], 'r-1');
});

test('redactArgs: privileged/legal tools drop args entirely (returns null)', () => {
  assert.equal(redactArgs('legal_blob_put', { container: 'personal', content: 'anything' }), null);
  assert.equal(redactArgs('legal_blob_get', { container: 'company' }), null);
  assert.equal(redactArgs('kb_search_privileged', { query: 'q' }), null);
});

test('redactArgs: a non-privileged tool still returns a (possibly empty) object, never null', () => {
  const out = redactArgs('github_push_files', { path: 'a.ts' });
  assert.notEqual(out, null);
});

test('redactArgs: a value longer than MAX_VALUE_CHARS is truncated with a marker', () => {
  // Spaced prose (not a pure alnum run), so it exercises the LENGTH cap specifically rather than
  // also tripping looksLikeSecretValue's long-base64-blob heuristic (a monotonous run of a single
  // base64-alphabet char, e.g. 'x'.repeat(N), legitimately looks like a base64 blob too).
  const long = 'word '.repeat(Math.ceil((MAX_VALUE_CHARS + 50) / 5));
  assert.ok(long.length > MAX_VALUE_CHARS, 'fixture must exceed the per-value cap');
  const out = redactArgs('some_tool', { note: long });
  const val = out!.note as string;
  assert.ok(val.length < long.length);
  assert.match(val, /^word word .*…\[truncated \d+ chars\]$/);
});

test('redactArgs: the whole serialized result is capped near MAX_TOTAL_CHARS', () => {
  // Spaced prose per field, well under MAX_VALUE_CHARS individually, so this isolates the TOTAL
  // cap (not the per-value cap or the secret-blob heuristic).
  const big: Record<string, string> = {};
  for (let i = 0; i < 20; i++) big[`field_${i}`] = 'plain word '.repeat(13); // ~143 chars, has spaces
  const out = redactArgs('some_tool', big);
  assert.equal(out!._truncated, true);
  assert.ok((out!.preview as string).length <= MAX_TOTAL_CHARS + 20);
});

test('redactArgs: never throws on weird input (null, array, primitive)', () => {
  assert.doesNotThrow(() => redactArgs('t', null));
  assert.doesNotThrow(() => redactArgs('t', undefined));
  assert.doesNotThrow(() => redactArgs('t', 'a string'));
  assert.doesNotThrow(() => redactArgs('t', [1, 2, 3]));
});

// ---- buildEpisodeText (pure, deterministic) ----------------------------------------------------

test('buildEpisodeText: deterministic — the same input always produces the same output', () => {
  const input = { tool: 'memory_write', actor: 'cto', outcome: 'success', redactedArgs: { kind: 'fact' } };
  assert.equal(buildEpisodeText(input), buildEpisodeText(input));
});

test('buildEpisodeText: includes actor, tool, and outcome', () => {
  const text = buildEpisodeText({ tool: 'task_create', actor: 'developer', outcome: 'success', redactedArgs: {} });
  assert.match(text, /developer/);
  assert.match(text, /task_create/);
  assert.match(text, /success/);
});

test('buildEpisodeText: redactedArgs=null (privileged/legal) renders ONLY {tool, outcome} — no args, no artifact', () => {
  const text = buildEpisodeText({
    tool: 'legal_blob_put',
    actor: 'clo',
    outcome: 'success',
    redactedArgs: null,
    artifact: 'should-never-appear',
  });
  assert.doesNotMatch(text, /args:/);
  assert.doesNotMatch(text, /artifact:/);
  assert.doesNotMatch(text, /should-never-appear/);
});

test('buildEpisodeText: a non-null empty redactedArgs omits the args section (nothing to show)', () => {
  const text = buildEpisodeText({ tool: 'wake', actor: 'cto', outcome: 'success', redactedArgs: {} });
  assert.doesNotMatch(text, /args:/);
});

test('buildEpisodeText: a non-empty redactedArgs is included', () => {
  const text = buildEpisodeText({ tool: 'memory_write', actor: 'cto', outcome: 'success', redactedArgs: { kind: 'fact' } });
  assert.match(text, /args:/);
  assert.match(text, /"kind":"fact"/);
});

test('buildEpisodeText: an artifact hint is included when redactedArgs is non-null', () => {
  const text = buildEpisodeText({
    tool: 'github_create_pull_request',
    actor: 'cto',
    outcome: 'success',
    redactedArgs: {},
    artifact: 'https://github.com/org/repo/pull/1',
  });
  assert.match(text, /artifact: https:\/\/github\.com\/org\/repo\/pull\/1/);
});

// ---- extractArtifactHint ---------------------------------------------------------------------------

test('extractArtifactHint: finds a top-level url-shaped key', () => {
  assert.equal(extractArtifactHint({ url: 'https://example.com/x' }), 'https://example.com/x');
  assert.equal(extractArtifactHint({ html_url: 'https://github.com/o/r/pull/2' }), 'https://github.com/o/r/pull/2');
});

test('extractArtifactHint: finds an id nested one level under a common wrapper key', () => {
  assert.equal(extractArtifactHint({ record: { id: 'm_abc123' } }), 'm_abc123');
  assert.equal(extractArtifactHint({ task: { id: 't_xyz789' } }), 't_xyz789');
});

test('extractArtifactHint: returns undefined when nothing artifact-shaped is present', () => {
  assert.equal(extractArtifactHint({ ok: true, count: 3 }), undefined);
  assert.equal(extractArtifactHint({}), undefined);
});

test('extractArtifactHint: never throws on non-object / null / array input', () => {
  assert.equal(extractArtifactHint(null), undefined);
  assert.equal(extractArtifactHint(undefined), undefined);
  assert.equal(extractArtifactHint('a string'), undefined);
  assert.equal(extractArtifactHint([1, 2, 3]), undefined);
});

// ---- safeAgentForJournal ----------------------------------------------------------------------------

test('safeAgentForJournal: a valid lane id passes through lowercased', () => {
  assert.equal(safeAgentForJournal('cto'), 'cto');
  assert.equal(safeAgentForJournal('CTO'), 'cto');
  assert.equal(safeAgentForJournal('dev_ops-1'), 'dev_ops-1');
});

test('safeAgentForJournal: empty or malformed input falls back to "gateway"', () => {
  assert.equal(safeAgentForJournal(''), 'gateway');
  assert.equal(safeAgentForJournal('   '), 'gateway');
  assert.equal(safeAgentForJournal('bad agent!'), 'gateway');
});
