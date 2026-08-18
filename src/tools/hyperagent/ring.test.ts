/**
 * Ring-safety tests for the Hyperagent broker.
 *
 * These are the load-bearing tests of this feature. Hyperagent's own MCP grants account-wide access
 * with no per-agent authorization, so ring.ts is the ONLY thing preventing a cto-lane call from
 * reaching an attorney-privileged CLO thread. Each test below pins one property that, if it
 * regressed, would produce exactly the cross-ring leak closed on 2026-07-16.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HYPERAGENT_EXEC_RING,
  HYPERAGENT_PERSONAL_LEGAL_RING,
  classifyAgent,
  isHyperagentAgentAllowed,
  parseAgentClassMap,
  parseLaneAgentMap,
  ringForClass,
  visibleAgentsFor,
} from './ring.js';

const NO_CLASSES = {};

// ---------------------------------------------------------------- config parsing fails CLOSED

test('parseLaneAgentMap drops malformed entries instead of treating them as wildcards', () => {
  const m = parseLaneAgentMap('cto=ag_1,ag_2; garbage ;=ag_3;cfo=;developer=ag_9');
  assert.deepEqual(m.cto, ['ag_1', 'ag_2']);
  assert.deepEqual(m.developer, ['ag_9']);
  assert.equal(m.cfo, undefined, 'a lane with an empty agent list must not appear at all');
  assert.equal(Object.keys(m).length, 2, 'no entry may be invented from malformed input');
});

test('parseLaneAgentMap of empty/undefined yields an empty map, so nobody reaches anything', () => {
  assert.deepEqual(parseLaneAgentMap(''), {});
  assert.deepEqual(parseLaneAgentMap(undefined), {});
  assert.deepEqual(parseLaneAgentMap(null), {});
});

test('parseAgentClassMap DROPS an unrecognised class rather than defaulting it to general', () => {
  // A typo widening access is the failure this guards. 'genral' must leave the agent `unknown`.
  const m = parseAgentClassMap('ag_1=exec;ag_2=genral;ag_3=general;ag_4=personal-legal');
  assert.equal(m.ag_1, 'exec');
  assert.equal(m.ag_2, undefined, 'a misspelled class must NOT become a permissive one');
  assert.equal(m.ag_3, 'general');
  assert.equal(m.ag_4, 'personal-legal');
});

// ---------------------------------------------------------------- classification

test('an agent nobody classified is `unknown`, and `unknown` reaches nobody', () => {
  assert.equal(classifyAgent({ id: 'ag_mystery', name: 'Some Agent' }, NO_CLASSES), 'unknown');
  assert.equal(ringForClass('unknown'), 'none');
});

test('clo-personal is classified BEFORE clo, so the most sensitive surface is not downgraded', () => {
  // "clo-personal" also contains "clo", which is in FORCED_EXEC. If the checks were ordered the
  // other way round, the live California family matter involving minors would be classified merely
  // `exec` and become readable by cfo/cpo/cco. This test exists to make that regression impossible.
  assert.equal(classifyAgent({ id: 'ag_x', name: 'CLO-Personal Counsel' }, NO_CLASSES), 'personal-legal');
  assert.equal(classifyAgent({ id: 'clo_personal_agent', name: 'x' }, NO_CLASSES), 'personal-legal');
  assert.equal(classifyAgent({ id: 'ag_y', name: 'CLO' }, NO_CLASSES), 'exec');
});

test('the forced pattern backstop OVERRIDES a permissive configured class', () => {
  // Someone mapping a CFO agent to `general` by mistake must not open it to every lane.
  const classes = parseAgentClassMap('ag_cfo=general');
  assert.equal(classifyAgent({ id: 'ag_cfo', name: 'CFO Finance Agent' }, classes), 'exec');
});

// ---------------------------------------------------------------- the enforcement predicate

test('BOTH conditions are required: assignment alone does not grant, ring alone does not grant', () => {
  const classes = parseAgentClassMap('ag_fin=exec');
  // Assigned to cto, but cto is not in the exec ring -> refused on the ring.
  const assignedButOutOfRing = parseLaneAgentMap('cto=ag_fin');
  const a = isHyperagentAgentAllowed('cto', { id: 'ag_fin' }, assignedButOutOfRing, classes);
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'forbidden_ring');

  // In the exec ring, but never assigned this agent -> refused on the allowlist.
  const inRingButUnassigned = parseLaneAgentMap('cfo=ag_other');
  const b = isHyperagentAgentAllowed('cfo', { id: 'ag_fin' }, inRingButUnassigned, classes);
  assert.equal(b.allowed, false);
  assert.equal(b.reason, 'agent_not_assigned_to_lane');

  // Both -> allowed.
  const both = parseLaneAgentMap('cfo=ag_fin');
  assert.equal(isHyperagentAgentAllowed('cfo', { id: 'ag_fin' }, both, classes).allowed, true);
});

test('a personal-legal agent is refused to cfo/clo/cto even when explicitly assigned', () => {
  const classes = parseAgentClassMap('ag_pers=personal-legal');
  const laneMap = parseLaneAgentMap('cfo=ag_pers;clo=ag_pers;cto=ag_pers;clo-personal=ag_pers');
  for (const lane of ['cfo', 'clo', 'cto', 'developer', 'coo', 'cro']) {
    const v = isHyperagentAgentAllowed(lane, { id: 'ag_pers' }, laneMap, classes);
    assert.equal(v.allowed, false, `${lane} must never reach a personal-legal agent`);
  }
  assert.equal(isHyperagentAgentAllowed('clo-personal', { id: 'ag_pers' }, laneMap, classes).allowed, true);
});

test('an empty caller identity is refused (external/unknown callers resolve to "")', () => {
  const classes = parseAgentClassMap('ag_1=general');
  const laneMap = parseLaneAgentMap('cto=ag_1');
  assert.equal(isHyperagentAgentAllowed('', { id: 'ag_1' }, laneMap, classes).reason, 'no_caller_identity');
  assert.equal(isHyperagentAgentAllowed(undefined, { id: 'ag_1' }, laneMap, classes).allowed, false);
});

test('an agent with no id is refused, since the allowlist is keyed by id', () => {
  const laneMap = parseLaneAgentMap('cto=ag_1');
  const v = isHyperagentAgentAllowed('cto', { id: '', name: 'Nameless' }, laneMap, parseAgentClassMap('ag_1=general'));
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'agent_id_unknown');
});

// ---------------------------------------------------------------- the locking invariant

test('LOCK: the personal-legal ring is a strict SUBSET of the exec ring', () => {
  // Mirrors the invariant pinned for PERSONAL_LEGAL_RING in kb/search-privileged.ts. Widening the
  // personal ring beyond the exec ring would be a new grant, never a tightening, so it must fail here.
  for (const lane of HYPERAGENT_PERSONAL_LEGAL_RING) {
    assert.ok(HYPERAGENT_EXEC_RING.includes(lane), `${lane} is in the personal ring but not the exec ring`);
  }
  assert.ok(
    HYPERAGENT_PERSONAL_LEGAL_RING.length < HYPERAGENT_EXEC_RING.length,
    'the personal-legal ring must be strictly narrower than the exec ring',
  );
});

test('LOCK: cto is in NEITHER privileged ring', () => {
  // cto is the broad, externally-reachable connector identity. Keeping it out of both rings caps the
  // blast radius of the most widely-connected lane, exactly as kb_search_privileged does.
  assert.ok(!HYPERAGENT_EXEC_RING.includes('cto'));
  assert.ok(!HYPERAGENT_PERSONAL_LEGAL_RING.includes('cto'));
});

// ---------------------------------------------------------------- listing filters, not just blocks

test('visibleAgentsFor OMITS agents a lane may not reach, so their names never leak', () => {
  const classes = parseAgentClassMap('ag_gen=general;ag_fin=exec;ag_pers=personal-legal');
  const laneMap = parseLaneAgentMap('cto=ag_gen,ag_fin,ag_pers;clo-personal=ag_pers');
  const all = [
    { id: 'ag_gen', name: 'General Ops' },
    { id: 'ag_fin', name: 'Finance' },
    { id: 'ag_pers', name: 'Personal Matter' },
  ];
  const seen = visibleAgentsFor('cto', all, laneMap, classes);
  assert.deepEqual(seen.map((a) => a.id), ['ag_gen'], 'cto sees only the general agent');
  // The refusal must not merely deny access — the privileged NAMES must be absent from the result.
  const blob = JSON.stringify(seen);
  assert.ok(!blob.includes('Personal Matter'), 'a privileged agent name must never appear');
  assert.ok(!blob.includes('Finance'), 'an exec-ring agent name must not appear to cto');
});
