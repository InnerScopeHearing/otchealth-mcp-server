import { test } from 'node:test';
import assert from 'node:assert/strict';
// protectedPrefixes()/isProtectedPath() (2026-08-04, CLO brief §1) call loadEnv(), so this file
// now needs the same required-env preamble every other loadEnv()-touching test file uses.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
import { isLegalContainerAllowed, lanesForContainer, protectedPrefixes, isProtectedPath } from './ring.js';
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

// protectedPrefixes()/isProtectedPath() (2026-08-04, CLO brief §1): the court-download folder and
// raw filings tree must never be deletable/movable regardless of caller or dry_run -- this is a
// SECOND, independent control from the soft-delete-to-_TRASH mechanism itself.

test('protectedPrefixes: defaults to the two named CLO-brief prefixes', () => {
  const prefixes = protectedPrefixes();
  assert.ok(prefixes.includes('clo-outgoing/Divorce Case Summary and ALL Filings/'));
  assert.ok(prefixes.includes('filings/'));
});

test('isProtectedPath: refuses anything under a protected prefix, including nested paths', () => {
  assert.equal(isProtectedPath('clo-outgoing/Divorce Case Summary and ALL Filings/petition.pdf'), true);
  assert.equal(isProtectedPath('clo-outgoing/Divorce Case Summary and ALL Filings/sub/deep/order.pdf'), true);
  assert.equal(isProtectedPath('filings/2026/petition.pdf'), true);
  // exact prefix with no trailing content still counts (it IS the protected root)
  assert.equal(isProtectedPath('filings/'), true);
});

test('isProtectedPath: does NOT false-positive on a merely-similar path outside the real prefix', () => {
  assert.equal(isProtectedPath('clo-outgoing/01-Divorce/petition.pdf'), false);
  assert.equal(isProtectedPath('correspondence/2026/filings-summary.pdf'), false); // "filings" substring, not prefix
  assert.equal(isProtectedPath('divorce/petition.pdf'), false);
});

test('isProtectedPath: strips a leading slash before matching', () => {
  assert.equal(isProtectedPath('/filings/2026/petition.pdf'), true);
});
