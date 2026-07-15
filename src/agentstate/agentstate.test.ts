import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authToken, aadAuthToken } from './cosmos.js';
import { resolveArtifact } from './resolver.js';
import { normalizeAgent } from './agents.js';
import { queueName } from './queue.js';

const KEY = Buffer.from('super-secret-master-key-not-real').toString('base64');
const DATE = 'Tue, 01 Jul 2026 00:00:00 GMT';

test('cosmos authToken: url-encoded master token shape', () => {
  const tok = authToken('GET', 'docs', 'dbs/agent-state/colls/tasks', DATE, KEY);
  assert.ok(tok.startsWith('type%3Dmaster%26ver%3D1.0%26sig%3D'), `unexpected token: ${tok.slice(0, 40)}`);
});

test('cosmos authToken: verb + date are case-insensitive (lowercased in string-to-sign)', () => {
  assert.equal(
    authToken('get', 'docs', 'dbs/agent-state/colls/tasks', DATE, KEY),
    authToken('GET', 'DOCS', 'dbs/agent-state/colls/tasks', DATE.toUpperCase(), KEY),
  );
});

test('cosmos authToken: resourceLink IS case-sensitive (ids must not be lowercased)', () => {
  assert.notEqual(
    authToken('GET', 'docs', 'dbs/agent-state/colls/tasks', DATE, KEY),
    authToken('GET', 'docs', 'dbs/Agent-State/colls/tasks', DATE, KEY),
  );
});

// ===== COSMOS_AUTH_MODE=aad (Phase 6 managed-identity migration) =====
// Pure pin for aadAuthToken() -- the network-dependent token-fetch/caching/failure behavior is
// covered in cosmos-aad.test.ts (needs its own process: COSMOS_AUTH_MODE + IDENTITY_ENDPOINT env
// must be set before this process's loadEnv() is first called, which happens on first use here).

test('cosmos aadAuthToken: url-encoded aad token shape (type=aad, NOT type=master)', () => {
  const tok = aadAuthToken('fake.aad.access.token');
  assert.ok(tok.startsWith('type%3Daad%26ver%3D1.0%26sig%3D'), `unexpected token: ${tok.slice(0, 40)}`);
  assert.equal(tok, encodeURIComponent('type=aad&ver=1.0&sig=fake.aad.access.token'));
});

test('cosmos aadAuthToken: the sig segment is the RAW access token -- no HMAC, no "Bearer " prefix', () => {
  const raw = 'eyFakeJwtHeader.eyFakePayload.fakeSignature';
  const tok = aadAuthToken(raw);
  assert.equal(decodeURIComponent(tok), `type=aad&ver=1.0&sig=${raw}`);
  // Distinguishes it from the master-key shape, which never contains raw token bytes in the clear.
  assert.notEqual(tok.slice(0, 15), authToken('GET', 'docs', 'dbs/x/colls/y', DATE, KEY).slice(0, 15));
});

test('done=artifact resolver rejects empty / bare / unknown-scheme uris (no network)', async () => {
  for (const uri of ['', 'done', 'finished in chat', 'ftp://x/y', 'branch:claude/foo']) {
    const r = await resolveArtifact(uri);
    assert.equal(r.resolved, false, `should reject "${uri}"`);
  }
});

test('normalizeAgent: clo-personal is accepted (2026-07-07: privilege wall lifted per standing CEO directive); valid ids normalize', () => {
  assert.equal(normalizeAgent('clo-personal'), 'clo-personal');
  assert.equal(normalizeAgent('CLO-Personal'), 'clo-personal');
  assert.equal(normalizeAgent('  CTO '), 'cto');
  assert.throws(() => normalizeAgent('bad id!'), /invalid agent/);
});

test('queueName builds a valid Azure queue name', () => {
  assert.equal(queueName('cto'), 'inbox-cto');
  assert.equal(queueName('dev_ops'), 'inbox-dev-ops');
});

test('queueName: clo-personal is accepted (2026-07-07: privilege wall lifted per standing CEO directive)', () => {
  assert.equal(queueName('clo-personal'), 'inbox-clo-personal');
});

test('SSRF guard: only https, internal/metadata IPs rejected (no network)', async () => {
  for (const uri of [
    'http://example.com/x', // non-https
    'https://169.254.169.254/latest/meta-data/', // cloud metadata (IMDS)
    'https://127.0.0.1/x', // loopback
    'https://10.0.0.5/x', // RFC1918
    'https://192.168.1.1/x', // RFC1918
    'https://[::1]/x', // IPv6 loopback
  ]) {
    const r = await resolveArtifact(uri);
    assert.equal(r.resolved, false, `should reject "${uri}"`);
  }
});

test('cosmos artifact resolver restricts containers + rejects traversal (no network)', async () => {
  for (const uri of [
    'cosmos:secrets/x/y', // container not allowlisted
    'cosmos:tasks/fleet', // too few segments
    'cosmos:tasks/fleet/..', // dot-only id
    'cosmos:tasks/fleet/a b', // space (not in safe charset)
  ]) {
    const r = await resolveArtifact(uri);
    assert.equal(r.resolved, false, `should reject "${uri}"`);
  }
});
