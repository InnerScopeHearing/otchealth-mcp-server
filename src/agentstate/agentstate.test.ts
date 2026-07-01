import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authToken } from './cosmos.js';
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

test('done=artifact resolver rejects empty / bare / unknown-scheme uris (no network)', async () => {
  for (const uri of ['', 'done', 'finished in chat', 'ftp://x/y', 'branch:claude/foo']) {
    const r = await resolveArtifact(uri);
    assert.equal(r.resolved, false, `should reject "${uri}"`);
  }
});

test('privilege wall: clo-personal is rejected; valid ids normalize', () => {
  assert.throws(() => normalizeAgent('clo-personal'), /privilege-walled/);
  assert.throws(() => normalizeAgent('CLO-Personal'), /privilege-walled/);
  assert.equal(normalizeAgent('  CTO '), 'cto');
  assert.throws(() => normalizeAgent('bad id!'), /invalid agent/);
});

test('queueName builds a valid Azure queue name', () => {
  assert.equal(queueName('cto'), 'inbox-cto');
  assert.equal(queueName('dev_ops'), 'inbox-dev-ops');
});
