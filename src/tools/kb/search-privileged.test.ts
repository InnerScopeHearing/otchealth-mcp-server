import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_LANES,
  EXEC_RING,
  PERSONAL_LEGAL_RING,
  OPS_RING,
  isLaneAllowed,
  isExecRingLane,
  isOpsRingLane,
  privilegeTierOf,
} from './search-privileged.js';

// Pins the ring-gating map for kb_search_privileged. Any future widening of a privileged ring must be
// an explicit, reviewable diff to THIS file — never a silent side effect of an unrelated change.

// Indexes gated to the FULL executive ring (finance + company-legal).
const EXEC_RING_INDEXES = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
];

// The MOST sensitive rooms — attorney-privileged personal legal (CA divorce/family/civil, minors' data).
// Gated NARROWER than the exec ring (Matt direction 2026-07-16, Option B): the dedicated personal-legal
// lane + the unified One-Brain chief ONLY.
const PERSONAL_LEGAL_INDEXES = ['legal-personal', 'legal-personal-memory'];

const ALL_PRIVILEGED_INDEXES = [...EXEC_RING_INDEXES, ...PERSONAL_LEGAL_INDEXES];

// The executive ring (CEO direction 2026-07-02; 'exec' unified chief added 2026-07-04): the C-suite lanes
// that share privileged FINANCE + COMPANY-LEGAL context. 'exec' = the single unified executive identity.
// coo/cro REMOVED 2026-07-21 (Matt direction, least-privilege), see EXCLUDED_AGENTS + the dedicated
// regression test below.
const EXEC_AGENTS = ['cfo', 'clo', 'clo-personal', 'cpo', 'cco', 'exec'];

// The personal-legal ring — the ONLY lanes allowed on the two personal-legal rooms.
const PERSONAL_LEGAL_AGENTS = ['clo-personal', 'exec'];

// Exec lanes STRIPPED from personal-legal: allowed on finance/company-legal, DENIED on the personal rooms.
// This set is exactly the cross-ring exposure that Option B closed (a cfo-lane read reached personal-legal).
// coo/cro are NOT in this set: they are no longer exec lanes at all (removed from EXEC_RING entirely,
// 2026-07-21), so they belong in EXCLUDED_AGENTS instead, refused on every privileged index.
const EXEC_BUT_NOT_PERSONAL_LEGAL = ['cfo', 'clo', 'cpo', 'cco'];

// Identities that must NEVER reach privileged data: the broad connector (cto/default), engineering IC,
// app-lead/product agents, focus group, unknown callers, and (2026-07-21, least-privilege) coo/cro,
// removed from EXEC_RING entirely so newly-provisioned coo/cro clients cannot read finance MNPI or
// company legal.
const EXCLUDED_AGENTS = [
  'cto',
  'default',
  'developer',
  'coo',
  'cro',
  'iheartest',
  'innerease',
  'flatstick',
  'companion',
  'focus-group',
  'nope',
];

test('INDEX_LANES: exactly the six expected privileged indexes are gated (no surprise additions/removals)', () => {
  assert.deepEqual(Object.keys(INDEX_LANES).sort(), [...ALL_PRIVILEGED_INDEXES].sort());
});

test('exec ring: every exec lane is allowed on the finance + company-legal indexes', () => {
  for (const index of EXEC_RING_INDEXES) {
    for (const agent of EXEC_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), true, `${agent} should be allowed on ${index}`);
    }
  }
});

// --- REGRESSION (2026-07-21, least-privilege): coo/cro removed from EXEC_RING entirely -----------------

test('REGRESSION: coo and cro are NOT members of EXEC_RING', () => {
  assert.ok(!(EXEC_RING as readonly string[]).includes('coo'), 'coo must not be in EXEC_RING');
  assert.ok(!(EXEC_RING as readonly string[]).includes('cro'), 'cro must not be in EXEC_RING');
  assert.deepEqual([...EXEC_RING].sort(), ['cco', 'cfo', 'clo', 'clo-personal', 'cpo', 'exec']);
});

test('REGRESSION: a coo caller and a cro caller are refused on finance-cfo-source-docs and legal-company', () => {
  for (const agent of ['coo', 'cro']) {
    assert.equal(isLaneAllowed('finance-cfo-source-docs', agent), false, `${agent} must NOT reach finance-cfo-source-docs`);
    assert.equal(isLaneAllowed('legal-company', agent), false, `${agent} must NOT reach legal-company`);
  }
});

test('REGRESSION: coo and cro are refused on EVERY privileged index (finance + company-legal + personal-legal)', () => {
  for (const agent of ['coo', 'cro']) {
    for (const index of ALL_PRIVILEGED_INDEXES) {
      assert.equal(isLaneAllowed(index, agent), false, `${agent} must NOT reach ${index}`);
    }
  }
});

// --- THE OPTION-B LOCK (2026-07-16): personal-legal is NARROWER than the exec ring -------------------

test('SAFETY-CRITICAL: personal-legal rooms are reachable ONLY by clo-personal + exec (Option B, 2026-07-16)', () => {
  for (const index of PERSONAL_LEGAL_INDEXES) {
    // allowed: EXACTLY the personal-legal ring, and nothing else
    for (const agent of PERSONAL_LEGAL_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), true, `${agent} must reach ${index}`);
    }
    // denied: every OTHER exec lane — this is the confirmed cross-ring leak that was fixed
    for (const agent of EXEC_BUT_NOT_PERSONAL_LEGAL) {
      assert.equal(
        isLaneAllowed(index, agent),
        false,
        `${agent} must NOT reach ${index} (personal-legal is clo-personal/exec only)`,
      );
    }
    // denied: every non-exec identity
    for (const agent of EXCLUDED_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), false, `${agent} must never reach ${index}`);
    }
  }
});

test('REGRESSION (the leak): the cfo lane can NO LONGER read the personal-legal rooms', () => {
  assert.equal(isLaneAllowed('legal-personal', 'cfo'), false);
  assert.equal(isLaneAllowed('legal-personal-memory', 'cfo'), false);
});

test('mutual cross-read preserved for finance + company-legal: clo/clo-personal read finance, cfo reads company-legal', () => {
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'clo'), true);
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'clo-personal'), true);
  assert.equal(isLaneAllowed('finance-cfo-memory', 'clo'), true);
  assert.equal(isLaneAllowed('legal-company', 'cfo'), true);
});

test('owning lanes still work (regression guard)', () => {
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'cfo'), true);
  assert.equal(isLaneAllowed('finance-otchealth-cfo-source-docs', 'cfo'), true);
  assert.equal(isLaneAllowed('finance-cfo-memory', 'cfo'), true);
  assert.equal(isLaneAllowed('legal-personal', 'clo-personal'), true);
  assert.equal(isLaneAllowed('legal-personal-memory', 'clo-personal'), true);
  assert.equal(isLaneAllowed('legal-company', 'clo'), true);
});

test('SAFETY-CRITICAL: the broad cto/default connector identity is refused on every privileged index', () => {
  for (const index of ALL_PRIVILEGED_INDEXES) {
    assert.equal(isLaneAllowed(index, 'cto'), false, `cto must never reach ${index}`);
    assert.equal(isLaneAllowed(index, 'default'), false, `default must never reach ${index}`);
  }
});

test('SAFETY-CRITICAL: non-exec identities (developer, app-leads, focus-group, unknown) are refused everywhere', () => {
  for (const index of ALL_PRIVILEGED_INDEXES) {
    for (const agent of EXCLUDED_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), false, `${agent} must never reach ${index}`);
    }
  }
});

test('a caller with no agent claim is refused on every privileged index', () => {
  for (const index of ALL_PRIVILEGED_INDEXES) {
    assert.equal(isLaneAllowed(index, ''), false);
    assert.equal(isLaneAllowed(index, undefined), false);
    assert.equal(isLaneAllowed(index, null), false);
  }
});

test('an unknown index name is refused for every agent, including exec ones', () => {
  assert.equal(isLaneAllowed('finance-does-not-exist', 'cfo'), false);
  assert.equal(isLaneAllowed('legal-does-not-exist', 'clo'), false);
  assert.equal(isLaneAllowed('legal-personal-does-not-exist', 'clo-personal'), false);
});

test('PERSONAL_LEGAL_RING is exactly [clo-personal, exec] and is a STRICT SUBSET of EXEC_RING (pure tightening)', () => {
  assert.deepEqual([...PERSONAL_LEGAL_RING].sort(), [...PERSONAL_LEGAL_AGENTS].sort());
  const exec = new Set<string>(EXEC_RING);
  for (const lane of PERSONAL_LEGAL_RING) {
    assert.equal(exec.has(lane), true, `${lane} must be within EXEC_RING (subset invariant — never a new grant)`);
  }
  // strictly narrower: at least one exec lane is intentionally NOT in the personal-legal ring
  assert.ok(PERSONAL_LEGAL_RING.length < EXEC_RING.length, 'personal-legal ring must be strictly narrower than exec');
});

test('SAFETY-CRITICAL: the union of all lane arrays is EXACTLY the exec ring — no fourth-party identity slips in', () => {
  const seen = new Set<string>();
  for (const lanes of Object.values(INDEX_LANES)) for (const l of lanes) seen.add(l);
  // Union is unchanged by Option B: clo-personal + exec (the personal-legal ring) also appear in the
  // finance rooms, so narrowing the personal rooms removed no lane from the overall union.
  assert.deepEqual([...seen].sort(), [...EXEC_AGENTS].sort());
  // and the exported EXEC_RING constant matches the intended ring exactly
  assert.deepEqual([...EXEC_RING].sort(), [...EXEC_AGENTS].sort());
});

// --- WAVE 3 ITEM 3.2: the OPS_RING three-tier split (2026-07-21) ---------------------------------
// This is a PURELY ADDITIVE architectural change. cpo and cco are NOT moved anywhere by it: they must
// remain exactly where they already are (full EXEC_RING members). Populating OPS_RING is item 3.1's
// separate, still-open decision; these tests pin today's state (empty) plus the invariants any future
// population must keep (disjoint from EXEC_RING and PERSONAL_LEGAL_RING, never smuggled into INDEX_LANES).

test('OPS_RING starts EMPTY (item 3.1, populating it, has not happened yet)', () => {
  assert.deepEqual([...OPS_RING], []);
});

test('REGRESSION (this task must not decide 3.1): cpo and cco remain exactly where they already were, full EXEC_RING members, not moved to OPS_RING or removed', () => {
  assert.ok((EXEC_RING as readonly string[]).includes('cpo'), 'cpo must remain in EXEC_RING');
  assert.ok((EXEC_RING as readonly string[]).includes('cco'), 'cco must remain in EXEC_RING');
  assert.equal(isOpsRingLane('cpo'), false, 'cpo must not be in OPS_RING (3.1 has not decided this)');
  assert.equal(isOpsRingLane('cco'), false, 'cco must not be in OPS_RING (3.1 has not decided this)');
  assert.deepEqual([...EXEC_RING].sort(), [...EXEC_AGENTS].sort(), 'EXEC_RING membership is byte-identical to before this change');
});

test('isOpsRingLane: false for every known lane today (the ring is empty), including exec lanes, non-exec lanes, and unknown/absent callers', () => {
  for (const lane of [...EXEC_AGENTS, ...EXCLUDED_AGENTS, 'randostring']) {
    assert.equal(isOpsRingLane(lane), false, `${lane} must not be in the currently-empty OPS_RING`);
  }
  assert.equal(isOpsRingLane(''), false);
  assert.equal(isOpsRingLane(undefined), false);
  assert.equal(isOpsRingLane(null), false);
});

test('isExecRingLane: true for exactly the exec agents, false for everyone else, matching isLaneAllowed on an EXEC_RING index', () => {
  for (const agent of EXEC_AGENTS) {
    assert.equal(isExecRingLane(agent), true, `${agent} should be an exec-ring lane`);
  }
  for (const agent of [...EXCLUDED_AGENTS, 'randostring']) {
    assert.equal(isExecRingLane(agent), false, `${agent} should not be an exec-ring lane`);
  }
  assert.equal(isExecRingLane(''), false);
  assert.equal(isExecRingLane(undefined), false);
  assert.equal(isExecRingLane(null), false);
});

test('OPS_RING is disjoint from EXEC_RING (no lane double-counted across tiers)', () => {
  const exec = new Set<string>(EXEC_RING);
  for (const lane of OPS_RING) {
    assert.equal(exec.has(lane), false, `${lane} must not be in both OPS_RING and EXEC_RING`);
  }
});

test('OPS_RING is disjoint from PERSONAL_LEGAL_RING', () => {
  const personal = new Set<string>(PERSONAL_LEGAL_RING);
  for (const lane of OPS_RING) {
    assert.equal(personal.has(lane), false, `${lane} must not be in both OPS_RING and PERSONAL_LEGAL_RING`);
  }
});

test('OPS_RING grants no access to any privileged index — INDEX_LANES has no ops-only entries and OPS_RING lanes (if any existed) would still be refused via isLaneAllowed', () => {
  // Structural: no INDEX_LANES value is exactly OPS_RING or references it. Every value today is
  // exactly EXEC_RING or PERSONAL_LEGAL_RING, spread from those constants, never OPS_RING.
  const execSet = new Set<string>(EXEC_RING);
  const personalSet = new Set<string>(PERSONAL_LEGAL_RING);
  for (const [index, lanes] of Object.entries(INDEX_LANES)) {
    const asExec = lanes.length === execSet.size && lanes.every((l) => execSet.has(l));
    const asPersonal = lanes.length === personalSet.size && lanes.every((l) => personalSet.has(l));
    assert.ok(asExec || asPersonal, `${index} must be gated to exactly EXEC_RING or PERSONAL_LEGAL_RING, never OPS_RING`);
  }
});

test('privilegeTierOf: classifies exec lanes as "exec", and every currently-known non-exec lane as "none" (OPS_RING is empty)', () => {
  for (const agent of EXEC_AGENTS) {
    assert.equal(privilegeTierOf(agent), 'exec', `${agent} should classify as exec`);
  }
  for (const agent of [...EXCLUDED_AGENTS, 'randostring']) {
    assert.equal(privilegeTierOf(agent), 'none', `${agent} should classify as none (no ops lane exists yet)`);
  }
  assert.equal(privilegeTierOf(''), 'none');
  assert.equal(privilegeTierOf(undefined), 'none');
  assert.equal(privilegeTierOf(null), 'none');
});

test('privilegeTierOf: exec wins over ops if a lane were ever (mistakenly) present in both rings (fails safe toward the more scrutinized tier)', () => {
  // OPS_RING is empty today, so this precedence rule cannot be observed against live data. Prove it
  // directly by temporarily forcing the overlap (OPS_RING is `readonly` only at the TYPE level; the
  // underlying array is an ordinary mutable runtime array) and restoring it in a finally, so this test
  // can never leak state into any other test regardless of pass/fail.
  const mutable = OPS_RING as unknown as string[];
  mutable.push('exec'); // 'exec' is already a real EXEC_RING member -- simulate the mistaken overlap
  try {
    assert.equal(isOpsRingLane('exec'), true, 'sanity: the forced overlap is visible to isOpsRingLane');
    assert.equal(isExecRingLane('exec'), true, 'sanity: exec is still an exec-ring lane');
    assert.equal(privilegeTierOf('exec'), 'exec', 'exec must win over ops on overlap (fail safe toward more scrutiny)');
  } finally {
    mutable.length = 0; // restore OPS_RING to empty for every other test in this file
  }
  assert.deepEqual([...OPS_RING], [], 'OPS_RING is restored to empty after this test');
});
