import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryWriteRefusal } from './memory-write.js';
import { EXEC_RING } from '../kb/search-privileged.js';

// Layer 3 (defense-in-depth) of the Phase 5/6 connector-ring closure (2026-07-15): before this,
// memory_write's handler wrote ANY input.agent namespace with ZERO caller authorization -- a
// connector-surface caller of any lane (or none at all) could write to the durable fleet
// memory-of-record. Layers 1 (registry.ts's per-lane connector toolset) and 2 (oauth.ts's DCR
// default lane) already keep an unauthorized connector from ever SEEING or being HANDED memory_write
// in the normal flow, but this handler-level gate is the last line: it refuses the call outright,
// fail-CLOSED, independent of how the caller reached the handler. Hermetic (no Cosmos, no network) --
// memoryWriteRefusal is a pure function of (connectorSurface, lane), mirroring isLaneAllowed() /
// isLegalContainerAllowed()'s "mock the two upstream signals as plain arguments" pattern.

test('SAFETY-CRITICAL: an external-read connector-surface caller is refused', () => {
  const refusal = memoryWriteRefusal(true, 'external-read');
  assert.ok(refusal, 'external-read must be refused on the connector surface');
  assert.match(refusal!, /not authorized to write fleet memory/);
});

test('a cto connector-surface caller is allowed (no refusal)', () => {
  assert.equal(memoryWriteRefusal(true, 'cto'), null);
});

test('a developer connector-surface caller is allowed', () => {
  assert.equal(memoryWriteRefusal(true, 'developer'), null);
});

test('every EXEC_RING lane is allowed to write memory over a connector surface', () => {
  for (const lane of EXEC_RING) {
    assert.equal(memoryWriteRefusal(true, lane), null, `${lane} should be allowed to write memory`);
  }
});

test('SAFETY-CRITICAL: an empty/unknown connector-surface lane is refused', () => {
  assert.ok(memoryWriteRefusal(true, ''));
  assert.ok(memoryWriteRefusal(true, 'randostring'));
});

test('non-connector-surface callers are NEVER refused by this gate (client_credentials / static token unaffected)', () => {
  assert.equal(memoryWriteRefusal(false, 'external-read'), null);
  assert.equal(memoryWriteRefusal(false, ''), null);
  assert.equal(memoryWriteRefusal(false, 'randostring'), null);
  assert.equal(memoryWriteRefusal(false, 'cto'), null);
});
