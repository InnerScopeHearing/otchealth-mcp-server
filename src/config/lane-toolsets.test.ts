import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_INTERNAL_LANES,
  LANE_TOOLSETS,
  isKnownInternalLane,
  isToolInLaneAllowlist,
} from './lane-toolsets.js';

test('KNOWN_INTERNAL_LANES lists exactly the 10 documented internal client_credentials lanes', () => {
  assert.deepEqual(
    [...KNOWN_INTERNAL_LANES].sort(),
    ['cco', 'cfo', 'clo', 'clo-personal', 'coo', 'cpo', 'cro', 'cto', 'developer', 'exec'].sort(),
  );
});

test('isKnownInternalLane: true for every listed lane, false for anything else', () => {
  for (const lane of KNOWN_INTERNAL_LANES) assert.equal(isKnownInternalLane(lane), true, lane);
  assert.equal(isKnownInternalLane(''), false);
  assert.equal(isKnownInternalLane('iheartest'), false);
  assert.equal(isKnownInternalLane('external-read'), false);
  assert.equal(isKnownInternalLane('randostring'), false);
  // Case-sensitive, matching every other lane predicate in this codebase (isShipLane, EXEC_RING
  // membership) -- lanes are always lowercased upstream in oauth.ts/descope.ts.
  assert.equal(isKnownInternalLane('CTO'), false);
});

test('every lane in LANE_TOOLSETS has a non-empty allowlist', () => {
  for (const lane of KNOWN_INTERNAL_LANES) {
    assert.ok(LANE_TOOLSETS[lane].length > 0, `${lane} should have a non-empty seed allowlist`);
  }
});

test('isToolInLaneAllowlist: exact-name match', () => {
  assert.equal(isToolInLaneAllowlist('cto', 'brain_search'), true);
  assert.equal(isToolInLaneAllowlist('cto', 'wake'), true);
});

test('isToolInLaneAllowlist: prefix* match', () => {
  assert.equal(isToolInLaneAllowlist('developer', 'github_create_branch'), true);
  // exec still carries the broad CTO_INFRA wildcards (unaffected by the 2026-08-02 M365 curation
  // fix -- see LANE_TOOLSETS's cto/cro doc comments), so it is the right lane to prove a genuine
  // prefix* match still works. 'depot_*' replaces the former 'azure_*' example here (2026-08-28:
  // the 13 azure_* tools were deleted outright and CTO_INFRA's 'azure_*' wildcard removed with
  // them, so it would no longer prove anything).
  assert.equal(isToolInLaneAllowlist('exec', 'depot_job_get'), true);
  assert.equal(isToolInLaneAllowlist('exec', 'depot_anything_else_entirely'), true);
});

test('isToolInLaneAllowlist: cto (2026-08-02 onward) is an explicit curated list, not a wildcard -- a literal seed member matches, an arbitrary same-service name does not', () => {
  // CTO_M365_CURATED replaced the old azure_*/github_*/... wildcards for cto specifically (root cause:
  // those wildcards admitted 99% of the whole catalog, defeating M365 curation -- see LANE_TOOLSETS's
  // cto entry doc comment). 'cloudflare_dns_record_get' is a real member of the curated list; an
  // unrelated, made-up cloudflare_* name is correctly NOT admitted. (This example used to be
  // azure_jobs_list / azure_anything_else_entirely; the 13 azure_* names were removed from the
  // curated list 2026-08-28 when those tools were deleted outright, so cloudflare_* now plays the
  // same illustrative role.)
  assert.equal(isToolInLaneAllowlist('cto', 'cloudflare_dns_record_get'), true);
  assert.equal(isToolInLaneAllowlist('cto', 'cloudflare_anything_else_entirely'), false);
});

test('isToolInLaneAllowlist: developer_wake_lite is reachable for the developer lane (2026-08-02 fix -- was silently excluded, invisible to catalog_probe\'s full-catalog-only check)', () => {
  assert.equal(isToolInLaneAllowlist('developer', 'developer_wake_lite'), true);
});

test('isToolInLaneAllowlist: a tool outside the lane list is rejected', () => {
  assert.equal(isToolInLaneAllowlist('developer', 'legal_blob_get'), false, 'developer has no privileged legal access');
  assert.equal(isToolInLaneAllowlist('clo-personal', 'graph_send_email'), false, 'clo-personal excludes fleet comms');
  assert.equal(isToolInLaneAllowlist('coo', 'xero_report'), false, 'coo was removed from EXEC_RING, no finance MNPI');
  assert.equal(isToolInLaneAllowlist('cro', 'legal_blob_get'), false, 'cro was removed from EXEC_RING, no privileged legal');
});

test('isToolInLaneAllowlist: FAIL-OPEN for an unknown lane (always true, regardless of tool)', () => {
  assert.equal(isToolInLaneAllowlist('some-unscoped-lane', 'depot_job_execute'), true);
  assert.equal(isToolInLaneAllowlist('', 'anything_at_all'), true);
});

test("exec's allowlist is a superset of every other EXEC_RING-adjacent lane's finance/legal surface", () => {
  // exec is documented as "every hat at once" -- spot-check it covers what cfo/clo/cpo/cco can reach.
  for (const tool of ['xero_report', 'legal_blob_get', 'posthog_query_hogql', 'sentry_list_issues']) {
    assert.equal(isToolInLaneAllowlist('exec', tool), true, tool);
  }
});

test('prefix patterns end in a literal asterisk and are matched by startsWith, not a regex', () => {
  // Sanity check on the pattern SHAPE itself (mirrors catalog/governance.ts's GovRule.pattern
  // convention) so a future edit cannot accidentally introduce a real regex metacharacter.
  for (const lane of KNOWN_INTERNAL_LANES) {
    for (const pattern of LANE_TOOLSETS[lane]) {
      if (pattern.includes('*')) {
        assert.ok(pattern.endsWith('*'), `${lane}'s pattern "${pattern}" must end in *, not contain one mid-string`);
      }
    }
  }
});
