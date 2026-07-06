import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLegalContainerAllowed, lanesForContainer } from './ring.js';
import { INDEX_LANES } from '../kb/search-privileged.js';

// Pins the ring-gating for the legal blob tools to the SAME source of truth as kb_search_privileged.
// The personal legal container must be gated identically to the legal-personal search index (the most
// sensitive corpus in the fleet), and company to legal-company — never broader. Any future widening is
// then a single reviewable diff in search-privileged.ts INDEX_LANES that flows to BOTH access paths.

test('legal container lanes are DERIVED from the sibling privileged index (single source of truth)', () => {
  assert.deepEqual(lanesForContainer('personal'), INDEX_LANES['legal-personal']);
  assert.deepEqual(lanesForContainer('company'), INDEX_LANES['legal-company']);
});

test('personal container: the brief-named lanes (clo-personal, clo, cfo) are all allowed', () => {
  for (const lane of ['clo-personal', 'clo', 'cfo']) {
    assert.equal(isLegalContainerAllowed('personal', lane), true, `${lane} should read legal/personal`);
  }
});

test('company container: clo + cfo allowed', () => {
  assert.equal(isLegalContainerAllowed('company', 'clo'), true);
  assert.equal(isLegalContainerAllowed('company', 'cfo'), true);
});

test('SAFETY-CRITICAL: the broad cto/default/external connector identity is refused on BOTH legal containers', () => {
  for (const container of ['company', 'personal'] as const) {
    assert.equal(isLegalContainerAllowed(container, 'cto'), false, `cto must never reach legal/${container}`);
    assert.equal(isLegalContainerAllowed(container, 'default'), false, `default must never reach legal/${container}`);
  }
});

test('SAFETY-CRITICAL: non-ring identities (developer, app-leads, focus-group, unknown) are refused on personal', () => {
  for (const agent of ['developer', 'iheartest', 'innerease', 'flatstick', 'companion', 'focus-group', 'nope']) {
    assert.equal(isLegalContainerAllowed('personal', agent), false, `${agent} must never reach legal/personal`);
  }
});

test('a caller with no agent claim is refused on both legal containers', () => {
  for (const container of ['company', 'personal'] as const) {
    assert.equal(isLegalContainerAllowed(container, ''), false);
    assert.equal(isLegalContainerAllowed(container, undefined), false);
    assert.equal(isLegalContainerAllowed(container, null), false);
  }
});

test('legal ring never widens beyond the exec ring union of the two indexes', () => {
  const union = new Set<string>([...INDEX_LANES['legal-personal'], ...INDEX_LANES['legal-company']]);
  const seen = new Set<string>([...lanesForContainer('personal'), ...lanesForContainer('company')]);
  assert.deepEqual([...seen].sort(), [...union].sort());
});
