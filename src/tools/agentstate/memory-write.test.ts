import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryWriteRefusal, memoryWriteIdentityRefusal } from './memory-write.js';
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

test('every EXEC_RING lane EXCEPT clo-personal is allowed to write memory over a connector surface', () => {
  // clo-personal IS a member of EXEC_RING (search-privileged.ts:81 -- it is the personal-legal ring's
  // own lane, PERSONAL_LEGAL_RING = ['clo-personal','exec']), but memory_write is a BROADCAST surface
  // (write-through indexed into memory-exec, read by every lane's brain_search), so it gets its own
  // unconditional carve-out below regardless of its EXEC_RING membership -- see the clo-personal test.
  for (const lane of EXEC_RING) {
    if (lane === 'clo-personal') continue;
    assert.equal(memoryWriteRefusal(true, lane), null, `${lane} should be allowed to write memory`);
  }
});

test('SAFETY-CRITICAL: an empty/unknown connector-surface lane is refused', () => {
  assert.ok(memoryWriteRefusal(true, ''));
  assert.ok(memoryWriteRefusal(true, 'randostring'));
});

test('non-connector-surface callers are NEVER refused by this gate (client_credentials / static token unaffected), EXCEPT clo-personal', () => {
  assert.equal(memoryWriteRefusal(false, 'external-read'), null);
  assert.equal(memoryWriteRefusal(false, ''), null);
  assert.equal(memoryWriteRefusal(false, 'randostring'), null);
  assert.equal(memoryWriteRefusal(false, 'cto'), null);
});

// Found + fixed 2026-07-30, alongside the identity-forgery gate below: memory_write's own docstring
// has always claimed "non-privileged (clo-personal rejected)", but nothing in the code enforced it --
// agents.ts's shared normalizeAgent() FORBIDDEN_AGENTS set is empty (by design; it is shared by every
// read/write path, including clo-personal's own legitimate self-reads elsewhere, so populating it
// there would break clo-personal's normal operation, not just this one tool). A clo-personal-
// authenticated caller writing under its OWN true identity would otherwise leak privileged
// personal-legal content onto memory-exec, a room every lane's brain_search reaches -- distinct from
// (and in addition to) the identity-forgery bug below, since here the caller's identity claim is
// entirely genuine, the room it lands in is simply the wrong one for that identity.
test('SAFETY-CRITICAL: clo-personal is refused UNCONDITIONALLY, connector surface or not', () => {
  const connectorRefusal = memoryWriteRefusal(true, 'clo-personal');
  assert.ok(connectorRefusal, 'clo-personal must be refused on the connector surface');
  assert.match(connectorRefusal!, /clo-personal/);
  assert.match(connectorRefusal!, /privilege-walled/);

  const directRefusal = memoryWriteRefusal(false, 'clo-personal');
  assert.ok(directRefusal, 'clo-personal must be refused even as a direct client_credentials caller');
  assert.match(directRefusal!, /clo-personal/);
});

test('clo-personal casing/whitespace variants are still caught', () => {
  assert.ok(memoryWriteRefusal(false, 'CLO-PERSONAL'));
  assert.ok(memoryWriteRefusal(false, '  clo-personal  '));
});

// IDENTITY-FORGERY GATE (found + fixed 2026-07-30): before this, the handler wrote input.agent
// verbatim as the record's attribution with ZERO check against the caller's own authenticated
// identity -- any caller reachable to memory_write could attribute a forged, byte-exact,
// broadly-recallable "system-of-record" entry to any OTHER lane (e.g. a low-privilege lane writing
// {agent:"cto", kind:"decision", text:"..."} to inject a fake decision every agent would trust as
// genuine on its next wake()/brain_search). memoryWriteIdentityRefusal is the fix: memory_write is
// self-write-only (unlike memory_remember's real cross-lane feature), so a requested `agent` that
// does not match the caller's authenticated identity is refused outright.

test('SAFETY-CRITICAL: a matching agent is allowed (self-write, the only legitimate case)', () => {
  assert.equal(memoryWriteIdentityRefusal('cto', 'cto'), null);
  assert.equal(memoryWriteIdentityRefusal('commerce', 'commerce'), null);
});

test('SAFETY-CRITICAL: a case/whitespace-only difference is still treated as a match', () => {
  assert.equal(memoryWriteIdentityRefusal('cto', 'CTO'), null);
  assert.equal(memoryWriteIdentityRefusal('cto', '  cto  '), null);
});

test('SAFETY-CRITICAL: this is the exact forgery this gate exists to stop -- a low-privilege caller cannot attribute a write to a DIFFERENT, more-trusted lane', () => {
  const refusal = memoryWriteIdentityRefusal('commerce', 'cto');
  assert.ok(refusal, 'commerce claiming to write as cto must be refused');
  assert.match(refusal!, /commerce/);
  assert.match(refusal!, /cto/);
});

test('SAFETY-CRITICAL: forgery is refused symmetrically, not just "up" toward a privileged lane', () => {
  const refusal = memoryWriteIdentityRefusal('cto', 'commerce');
  assert.ok(refusal, 'cto claiming to write as commerce must ALSO be refused -- this is an identity check, not a privilege check');
});

test('SAFETY-CRITICAL: no verifiable caller identity is refused outright, even with no requested agent to compare', () => {
  assert.ok(memoryWriteIdentityRefusal('', ''));
  assert.ok(memoryWriteIdentityRefusal('', 'cto'));
});

test('an empty/omitted requested agent is allowed when the caller has a real identity (defaults to self)', () => {
  assert.equal(memoryWriteIdentityRefusal('cto', ''), null);
});
