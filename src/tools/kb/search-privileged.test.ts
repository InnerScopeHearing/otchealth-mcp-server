import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_LANES, isLaneAllowed } from './search-privileged.js';

// This test suite pins the ring-gating map for kb_search_privileged. It exists to make any future
// widening of the privileged ring an explicit, reviewable diff to this file rather than a silent
// side effect of an unrelated change.

const PRIVILEGED_INDEXES = [
  'finance-cfo-source-docs',
  'finance-otchealth-cfo-source-docs',
  'finance-cfo-memory',
  'legal-company',
  'legal-personal',
  'legal-personal-memory',
];

const NON_PRIVILEGED_AGENTS = ['coo', 'cro', 'cpo', 'cco', 'developer'];

test('INDEX_LANES: exactly the six expected privileged indexes are gated (no surprise additions/removals)', () => {
  assert.deepEqual(Object.keys(INDEX_LANES).sort(), [...PRIVILEGED_INDEXES].sort());
});

test('mutual cross-read: clo and clo-personal are allowed on both finance indexes', () => {
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'clo'), true);
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'clo-personal'), true);
  assert.equal(isLaneAllowed('finance-otchealth-cfo-source-docs', 'clo'), true);
  assert.equal(isLaneAllowed('finance-otchealth-cfo-source-docs', 'clo-personal'), true);
});

test('mutual cross-read: cfo is allowed on both legal indexes', () => {
  assert.equal(isLaneAllowed('legal-company', 'cfo'), true);
  assert.equal(isLaneAllowed('legal-personal', 'cfo'), true);
});

test('mutual cross-read: the -memory ledger indexes are reachable and gated the same as their source-doc siblings', () => {
  // finance-cfo-memory mirrors finance-cfo-source-docs
  assert.equal(isLaneAllowed('finance-cfo-memory', 'cfo'), true);
  assert.equal(isLaneAllowed('finance-cfo-memory', 'clo'), true);
  assert.equal(isLaneAllowed('finance-cfo-memory', 'clo-personal'), true);
  // legal-personal-memory mirrors legal-personal
  assert.equal(isLaneAllowed('legal-personal-memory', 'clo-personal'), true);
  assert.equal(isLaneAllowed('legal-personal-memory', 'clo'), true);
  assert.equal(isLaneAllowed('legal-personal-memory', 'cfo'), true);
});

test('owning lane still works: cfo on finance, clo-personal on legal-personal (regression guard)', () => {
  assert.equal(isLaneAllowed('finance-cfo-source-docs', 'cfo'), true);
  assert.equal(isLaneAllowed('finance-otchealth-cfo-source-docs', 'cfo'), true);
  assert.equal(isLaneAllowed('finance-cfo-memory', 'cfo'), true);
  assert.equal(isLaneAllowed('legal-personal', 'clo-personal'), true);
  assert.equal(isLaneAllowed('legal-personal-memory', 'clo-personal'), true);
  assert.equal(isLaneAllowed('legal-company', 'clo'), true);
});

test('SAFETY-CRITICAL: no non-privileged agent (coo/cro/cpo/cco/developer) appears in ANY INDEX_LANES array', () => {
  for (const index of Object.keys(INDEX_LANES)) {
    for (const agent of NON_PRIVILEGED_AGENTS) {
      assert.equal(
        INDEX_LANES[index].includes(agent),
        false,
        `${agent} must never be added to the ${index} lane array — the ring is clo/cfo/clo-personal only`,
      );
    }
  }
});

test('SAFETY-CRITICAL: no non-privileged agent is granted access via isLaneAllowed on any privileged index', () => {
  for (const index of PRIVILEGED_INDEXES) {
    for (const agent of NON_PRIVILEGED_AGENTS) {
      assert.equal(isLaneAllowed(index, agent), false);
    }
  }
});

test('SAFETY-CRITICAL: the cto/default/static-connector identity is refused on every privileged index', () => {
  for (const index of PRIVILEGED_INDEXES) {
    assert.equal(isLaneAllowed(index, 'cto'), false);
    assert.equal(isLaneAllowed(index, 'default'), false);
  }
});

test('a caller with no agent claim is refused on every privileged index', () => {
  for (const index of PRIVILEGED_INDEXES) {
    assert.equal(isLaneAllowed(index, ''), false);
    assert.equal(isLaneAllowed(index, undefined), false);
    assert.equal(isLaneAllowed(index, null), false);
  }
});

test('an unknown index name is refused for every agent, including privileged ones', () => {
  assert.equal(isLaneAllowed('finance-does-not-exist', 'cfo'), false);
  assert.equal(isLaneAllowed('legal-does-not-exist', 'clo'), false);
});

test('lane arrays contain only the three privileged identities, never a fourth', () => {
  const ALLOWED = new Set(['cfo', 'clo', 'clo-personal']);
  for (const [index, lanes] of Object.entries(INDEX_LANES)) {
    for (const lane of lanes) {
      assert.ok(ALLOWED.has(lane), `${index} lane array contains unexpected identity "${lane}"`);
    }
  }
});
