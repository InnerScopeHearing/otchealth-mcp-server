import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_LANES, EXEC_RING, isLaneAllowed } from './search-privileged.js';

// Pins the ring-gating map for kb_search_privileged. Any future widening of the privileged ring must be
// an explicit, reviewable diff to this file — never a silent side effect of an unrelated change.

const PRIVILEGED_INDEXES = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
  'legal-personal',
  'legal-personal-memory',
];

// The executive ring (CEO direction 2026-07-02; 'exec' unified chief added 2026-07-04): the C-suite lanes
// that share privileged context. 'exec' = the single unified executive identity for the solo operator.
const EXEC_AGENTS = ['cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec'];

// Identities that must NEVER reach privileged data: the broad connector (cto/default), engineering IC,
// app-lead/product agents, focus group, unknown callers.
const EXCLUDED_AGENTS = [
  'cto',
  'default',
  'developer',
  'iheartest',
  'innerease',
  'flatstick',
  'companion',
  'focus-group',
  'nope',
];

test('INDEX_LANES: exactly the six expected privileged indexes are gated (no surprise additions/removals)', () => {
  assert.deepEqual(Object.keys(INDEX_LANES).sort(), [...PRIVILEGED_INDEXES].sort());
});

test('exec ring: every exec lane is allowed on every privileged index', () => {
  for (const index of PRIVILEGED_INDEXES) {
    for (const agent of EXEC_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), true, `${agent} should be allowed on ${index}`);
    }
  }
});

test('mutual cross-read preserved: clo/clo-personal read finance, cfo reads legal (regression from #68)', () => {
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'clo'), true);
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'clo-personal'), true);
  assert.equal(isLaneAllowed('finance-cfo-memory', 'clo'), true);
  assert.equal(isLaneAllowed('legal-company', 'cfo'), true);
  assert.equal(isLaneAllowed('legal-personal', 'cfo'), true);
  assert.equal(isLaneAllowed('legal-personal-memory', 'cfo'), true);
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
  for (const index of PRIVILEGED_INDEXES) {
    assert.equal(isLaneAllowed(index, 'cto'), false, `cto must never reach ${index}`);
    assert.equal(isLaneAllowed(index, 'default'), false, `default must never reach ${index}`);
  }
});

test('SAFETY-CRITICAL: non-exec identities (developer, app-leads, focus-group, unknown) are refused everywhere', () => {
  for (const index of PRIVILEGED_INDEXES) {
    for (const agent of EXCLUDED_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), false, `${agent} must never reach ${index}`);
    }
  }
});

test('a caller with no agent claim is refused on every privileged index', () => {
  for (const index of PRIVILEGED_INDEXES) {
    assert.equal(isLaneAllowed(index, ''), false);
    assert.equal(isLaneAllowed(index, undefined), false);
    assert.equal(isLaneAllowed(index, null), false);
  }
});

test('an unknown index name is refused for every agent, including exec ones', () => {
  assert.equal(isLaneAllowed('finance-does-not-exist', 'cfo'), false);
  assert.equal(isLaneAllowed('legal-does-not-exist', 'clo'), false);
});

test('SAFETY-CRITICAL: the union of all lane arrays is EXACTLY the exec ring — no fourth-party identity slips in', () => {
  const seen = new Set<string>();
  for (const lanes of Object.values(INDEX_LANES)) for (const l of lanes) seen.add(l);
  assert.deepEqual([...seen].sort(), [...EXEC_AGENTS].sort());
  // and the exported EXEC_RING constant matches the intended ring exactly
  assert.deepEqual([...EXEC_RING].sort(), [...EXEC_AGENTS].sort());
});
