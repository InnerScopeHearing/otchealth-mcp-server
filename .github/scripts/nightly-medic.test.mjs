// Regression test for the 2026-08-30 fix: findLogIssue() must prefer an explicit
// FLEET_MEDIC_LOG_ISSUE override (mirroring the gateway's own env var of the same name) over the
// dynamic "Nightly Medic Log" title search, and must fall back to that search when the override
// is absent, unparseable, or points at an issue that is not open.
//
// Run: npx tsx --test .github/scripts/nightly-medic.test.mjs   (or: node --test <this file>)
//
// Fail-on-old-code proof: reverting the findLogIssue() override branch in nightly-medic.mjs makes
// "prefers the override issue" and "does not call search when override succeeds" fail, because
// the mocked fetch would then see a request to /search/issues that this test asserts never
// happens, and the resolved issue would be #21 (from the search fixture) instead of #258.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Set required/consumed env vars BEFORE importing the module under test: nightly-medic.mjs reads
// process.env.GH_PAT / REPO at module-evaluation time (top-level consts), and the module's own
// isMain guard (import.meta.url vs process.argv[1]) keeps its runtime IIFE from firing on import
// regardless -- these values just need to exist so header construction and REPO interpolation in
// asserted URLs are deterministic.
process.env.GH_PAT = 'test-pat';
process.env.REPO = 'InnerScopeHearing/otchealth-mcp-server';

const { findLogIssue } = await import('./nightly-medic.mjs');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [matcher, respond] of routes) {
      const matches = matcher instanceof RegExp ? matcher.test(url) : url.includes(matcher);
      if (matches) return respond();
    }
    throw new Error(`fakeFetch: no route matched ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const okJson = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('findLogIssue prefers FLEET_MEDIC_LOG_ISSUE when it names an open issue, and never calls search', async (t) => {
  process.env.FLEET_MEDIC_LOG_ISSUE = '258';
  t.after(() => { delete process.env.FLEET_MEDIC_LOG_ISSUE; });

  const fetchMock = fakeFetch([
    ['/issues/258', () => okJson({ number: 258, state: 'open', title: 'fleet-medic alert log v2 (successor to #21)' })],
    [/\/search\/issues/, () => { throw new Error('must not search when the override resolves'); }],
  ]);
  t.mock.method(globalThis, 'fetch', fetchMock);

  const issue = await findLogIssue();
  assert.equal(issue.number, 258, 'must resolve to the overridden issue, not the title-search result');
  assert.ok(fetchMock.calls.some((u) => u.includes('/issues/258')), 'must fetch the override issue directly');
  assert.ok(!fetchMock.calls.some((u) => u.includes('/search/issues')), 'must not fall back to the title search when the override succeeds');
});

test('findLogIssue falls back to the title search when FLEET_MEDIC_LOG_ISSUE points at a closed issue', async (t) => {
  process.env.FLEET_MEDIC_LOG_ISSUE = '258';
  t.after(() => { delete process.env.FLEET_MEDIC_LOG_ISSUE; });

  const fetchMock = fakeFetch([
    ['/issues/258', () => okJson({ number: 258, state: 'closed' })],
    [/\/search\/issues/, () => okJson({ items: [{ number: 21, state: 'open', title: '🤖 Nightly Medic Log' }] })],
  ]);
  t.mock.method(globalThis, 'fetch', fetchMock);

  const issue = await findLogIssue();
  assert.equal(issue.number, 21, 'a closed override target must fall back to the search result');
});

test('findLogIssue falls back to the title search when FLEET_MEDIC_LOG_ISSUE is unset (old behavior preserved)', async (t) => {
  delete process.env.FLEET_MEDIC_LOG_ISSUE;

  const fetchMock = fakeFetch([
    [/\/search\/issues/, () => okJson({ items: [{ number: 21, state: 'open', title: '🤖 Nightly Medic Log' }] })],
  ]);
  t.mock.method(globalThis, 'fetch', fetchMock);

  const issue = await findLogIssue();
  assert.equal(issue.number, 21);
});

test('findLogIssue falls back to the title search when FLEET_MEDIC_LOG_ISSUE is not a positive integer', async (t) => {
  process.env.FLEET_MEDIC_LOG_ISSUE = 'not-a-number';
  t.after(() => { delete process.env.FLEET_MEDIC_LOG_ISSUE; });

  const fetchMock = fakeFetch([
    [/\/search\/issues/, () => okJson({ items: [{ number: 21, state: 'open' }] })],
  ]);
  t.mock.method(globalThis, 'fetch', fetchMock);

  const issue = await findLogIssue();
  assert.equal(issue.number, 21);
});
