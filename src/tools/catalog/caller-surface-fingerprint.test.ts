import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerSurfaceFingerprint } from './caller-surface-fingerprint.js';

test('caller surface fingerprint sorts tool names and object keys but preserves schema array order', () => {
  const first = callerSurfaceFingerprint([
    { name: 'z', inputSchema: { required: ['a', 'b'], properties: { b: { type: 'string' }, a: { type: 'number' } } } },
    { name: 'a', description: 'tool' },
  ]);
  const reordered = callerSurfaceFingerprint([
    { description: 'tool', name: 'a' },
    { inputSchema: { properties: { a: { type: 'number' }, b: { type: 'string' } }, required: ['a', 'b'] }, name: 'z' },
  ]);
  assert.equal(first, reordered);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(
    first,
    callerSurfaceFingerprint([
      { name: 'a', description: 'tool' },
      { name: 'z', inputSchema: { required: ['b', 'a'], properties: { a: { type: 'number' }, b: { type: 'string' } } } },
    ]),
  );
});

test('caller surface fingerprint changes for schema and exposure drift', () => {
  const baseline = callerSurfaceFingerprint([{ name: 'safe_read', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]);
  assert.notEqual(baseline, callerSurfaceFingerprint([{ name: 'safe_read', inputSchema: { type: 'object', properties: { q: { type: 'number' } } } }]));
  assert.notEqual(baseline, callerSurfaceFingerprint([{ name: 'write_action', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]));
});
