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

test('personal container (Option B, 2026-07-16): reachable ONLY by clo-personal + exec; cfo + company-legal clo are STRIPPED', () => {
  // allowed: exactly the narrowed personal-legal ring
  for (const lane of ['clo-personal', 'exec']) {
    assert.equal(isLegalContainerAllowed('personal', lane), true, `${lane} should read legal/personal`);
  }
  // denied: the individual chiefs and the company-legal lane (this is the cross-ring exposure that was closed)
  for (const lane of ['cfo', 'clo', 'cpo', 'cco']) {
    assert.equal(isLegalContainerAllowed('personal', lane), false, `${lane} must NOT reach legal/personal (clo-personal/exec only)`);
  }
});

test('REGRESSION (2026-07-21, least-privilege): coo and cro are removed from EXEC_RING and refused on legal-company too, not only legal-personal', () => {
  for (const lane of ['coo', 'cro']) {
    assert.equal(isLegalContainerAllowed('company', lane), false, `${lane} must NOT reach legal/company (removed from EXEC_RING)`);
    assert.equal(isLegalContainerAllowed('personal', lane), false, `${lane} must NOT reach legal/personal`);
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
