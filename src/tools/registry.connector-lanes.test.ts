import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { connectorToolset, isShipLane, CTO_SHIP_LANE_TOOLSET, EXTERNAL_READONLY_TOOLSET } from './registry.js';
import { EXEC_RING } from './kb/search-privileged.js';
import { loadEnv, type Env } from '../config/env.js';

// Pins the Phase 5/6 connector-ring closure (2026-07-15), layer 1: the connector toolset a caller
// sees MUST depend on its OAuth-derived lane, not be one global set. Before this split, EVERY
// connector -- including an unrecognized/external one, which oauth.ts's laneFromClientName()
// defaulted to the privileged 'clo' lane -- got the FULL ship-lane set (kb_search_privileged,
// legal_blob_*, memory_write, ...). That was a live, externally-reachable privileged-access hole:
// any Claude.ai account holder could add this gateway as a custom connector, name it something
// unrecognized, and read attorney-privileged legal docs + MNPI finance RAG and write fleet memory.
//
// This test locks the lane routing so a regression here (accidentally widening
// EXTERNAL_READONLY_TOOLSET, or narrowing the ship set for cto/developer/EXEC_RING) is caught
// immediately, and so CTO_SHIP_LANE_TOOLSET never silently drifts from what the seat actually needs.

before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

function testEnv(): Env {
  return loadEnv();
}

test('CTO_SHIP_LANE_TOOLSET and EXTERNAL_READONLY_TOOLSET are disjoint from each other in intent: the external set is a strict, minimal subset of tool names', () => {
  // Sanity check on the fixtures themselves before testing the routing that hands them out.
  // 9 original read tools + Phase 6's search/fetch (OpenAI connector contract) = 11.
  assert.equal(EXTERNAL_READONLY_TOOLSET.length, 11);
  for (const name of EXTERNAL_READONLY_TOOLSET) {
    assert.ok(CTO_SHIP_LANE_TOOLSET.includes(name), `${name} should also be reachable on the ship lane`);
  }
});

test('(a) cto lane gets the full ship-lane set, including the privileged tools', () => {
  const set = connectorToolset(testEnv(), 'cto');
  assert.deepEqual([...set].sort(), [...CTO_SHIP_LANE_TOOLSET].sort());
  assert.ok(set.has('kb_search_privileged'));
  assert.ok(set.has('memory_write'));
});

test('(b) developer lane gets the full ship-lane set', () => {
  const set = connectorToolset(testEnv(), 'developer');
  assert.deepEqual([...set].sort(), [...CTO_SHIP_LANE_TOOLSET].sort());
});

test('(c) every EXEC_RING lane gets the full ship-lane set', () => {
  const env = testEnv();
  for (const lane of EXEC_RING) {
    const set = connectorToolset(env, lane);
    assert.deepEqual([...set].sort(), [...CTO_SHIP_LANE_TOOLSET].sort(), `${lane} should get the ship set`);
  }
});

test("(d) 'external-read' lane set is EXACTLY the 11 read tools (incl. Phase 6 search/fetch) and excludes every privileged/write tool", () => {
  const set = connectorToolset(testEnv(), 'external-read');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
  assert.equal(set.size, 11);
  assert.ok(set.has('search'), 'external-read must see the OpenAI connector search tool');
  assert.ok(set.has('fetch'), 'external-read must see the OpenAI connector fetch tool');
  for (const forbidden of [
    'kb_search_privileged',
    'legal_blob_list', 'legal_blob_get', 'legal_blob_put',
    'memory_write', 'memory_remember',
    'github_push_files', 'github_merge_pull_request', 'github_create_pull_request',
    'azure_job_execute', 'azure_containerapp_set_env',
  ]) {
    assert.equal(set.has(forbidden), false, `external-read must never see ${forbidden}`);
  }
});

test("(e) '' (empty/unknown caller) lane gets EXACTLY the external read set", () => {
  const set = connectorToolset(testEnv(), '');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
});

test("(f) an unrecognized lane string gets EXACTLY the external read set (regression guard for THE HOLE this closes)", () => {
  const set = connectorToolset(testEnv(), 'randostring');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
});

test('isShipLane: exact predicate matches the routing above', () => {
  assert.equal(isShipLane('cto'), true);
  assert.equal(isShipLane('developer'), true);
  for (const lane of EXEC_RING) assert.equal(isShipLane(lane), true, `${lane} should be a ship lane`);
  assert.equal(isShipLane(''), false);
  assert.equal(isShipLane('external-read'), false);
  assert.equal(isShipLane('randostring'), false);
  // Case-sensitivity is deliberate: lanes are always lowercased upstream (oauth.ts / descope.ts).
  // A caller string that doesn't exactly match is never a ship lane.
  assert.equal(isShipLane('CTO'), false);
});

test('CONNECTOR_TOOLSET env override still overrides the ship set (back-compat)', () => {
  const env = { ...testEnv(), CONNECTOR_TOOLSET: 'brain_search,web_search' } as Env;
  const set = connectorToolset(env, 'cto');
  assert.deepEqual([...set].sort(), ['brain_search', 'web_search']);
});

test('EXTERNAL_READONLY_TOOLSET env override overrides the external set', () => {
  const env = { ...testEnv(), EXTERNAL_READONLY_TOOLSET: 'brain_search' } as Env;
  const set = connectorToolset(env, 'external-read');
  assert.deepEqual([...set], ['brain_search']);
});
