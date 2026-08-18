import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { connectorToolset, isShipLane, CTO_SHIP_LANE_TOOLSET, CRO_CONNECTOR_TOOLSET, EXTERNAL_READONLY_TOOLSET, WEFUNDER_CAMPAIGN_DIRECTOR_CONNECTOR_TOOLSET } from './registry.js';
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
  // Regression guard (2026-07-17): the CFO reported kb_get_document was invisible on its DCR
  // connector because #130 shipped the tool into the catalog but never added it to this ship set.
  assert.ok(set.has('kb_get_document'), 'ship lane must expose whole-doc retrieval (the CFO census gap)');
  // Regression guard (2026-08-18): kb_get_sheet -- reads real XLSX cell values (formula cached
  // results, dates, merges) instead of the _TEXT/ sidecar. Same omission class as every tool above;
  // pinned by name so a future edit here can't silently drop it and make it connector-invisible again.
  assert.ok(set.has('kb_get_sheet'), 'ship lane must expose XLSX cell-value retrieval (the CFO numeric-data gap)');
  // Regression guard (2026-07-30, P0-1): the CFO reported xero_attachment_upload was invisible on
  // its connector even though it was fully built, registered, and reachable via a direct minted-
  // token MCP call -- it was simply never added to this ship set (its read-side sibling
  // xero_attachments was, since day one). Also assert every OTHER xero_* tool the CFO actually
  // depends on stays present, so a future edit here can't silently drop one again.
  assert.ok(set.has('xero_attachment_upload'), 'ship lane must expose xero attachment upload (the CFO round-trip-verification gap)');
  for (const xeroTool of ['xero_attachments', 'xero_request', 'xero_accounts', 'xero_get']) {
    assert.ok(set.has(xeroTool), `ship lane must still expose ${xeroTool}`);
  }
  // Regression guard (2026-07-30, CFO round-2 mega-prompt): a Copilot review caught xero_gl_assemble
  // and xero_connections repeating the EXACT SAME omission class as xero_attachment_upload above --
  // both were built, registered, and EXEC_RING-gated, but never added here, so the CFO connector
  // could not see or call either. Pinned by name so it can't silently regress again.
  for (const xeroTool of ['xero_gl_assemble', 'xero_connections']) {
    assert.ok(set.has(xeroTool), `ship lane must expose ${xeroTool} (the CFO GL-assembly gap)`);
  }
  // Regression guard (2026-08-03): catalog_probe -- the diagnostic tool that reports THIS request's
  // caller_agent/is_connector_surface/is_m365_static_auth -- was itself never added to this ship set,
  // so it was invisible to every connector-surface caller, including the ones a CLO/CPO/CCO connector
  // showing an unexpectedly narrow toolset most needed it for. Same omission class as
  // developer_wake_lite (2026-08-02) and xero_attachment_upload (2026-07-30).
  assert.ok(set.has('catalog_probe'), 'ship lane must expose catalog_probe so a stuck connector can self-diagnose its own auth context');
  for (const browserTool of ['browser_broker_preflight', 'browser_broker_inspect_public']) {
    assert.ok(set.has(browserTool), `ship lane must expose ${browserTool} for its independently enforced public-read broker contract`);
  }
  // Regression guard (2026-08-04): mail_archive_* -- built for the CFO's Exchange Online Archive
  // problem, EXEC_RING-gated in-handler, but never added to this ship set, so it was invisible on
  // every connector even though it already solves a problem the CFO reported as unsolvable by any
  // permission fix. Same omission class as catalog_probe/xero_attachment_upload/kb_get_document.
  for (const mailArchiveTool of [
    'mail_archive_list_folders', 'mail_archive_search', 'mail_archive_get_message',
    'mail_archive_download_attachment', 'mail_archive_save_attachment_to_dataroom',
  ]) {
    assert.ok(set.has(mailArchiveTool), `ship lane must expose ${mailArchiveTool} (the CFO archive-mailbox gap)`);
  }
  // HeyGen OAuth broker: ship connectors need visibility, but authorization remains the explicit
  // in-handler six-lane/data + CTO-only pairing/create checks. The external set below must never receive them.
  for (const heygenTool of [
    'heygen_pairing_start', 'heygen_pairing_status', 'heygen_account_get',
    'heygen_videos_list', 'heygen_video_get', 'heygen_video_agent_styles_list',
    'heygen_avatar_groups_list', 'heygen_avatar_group_get', 'heygen_avatar_looks_list',
    'heygen_avatar_look_get', 'heygen_voices_list', 'heygen_voice_design', 'heygen_voice_get',
    'heygen_video_statuses_get', 'heygen_video_agent_sessions_list', 'heygen_video_agent_session_get',
    'heygen_video_agent_session_videos_list', 'heygen_brand_kits_list', 'heygen_brand_glossaries_list',
    'heygen_brand_glossary_get', 'heygen_translation_languages_list', 'heygen_translations_list',
    'heygen_translation_get', 'heygen_translation_statuses_get', 'heygen_proofread_get',
    'heygen_avatar_video_operation_get', 'heygen_owner_approval_status_get', 'heygen_prompt_avatar_create', 'heygen_avatar_video_create',
    'heygen_video_wait_ingest_qa',
  ]) {
    assert.ok(set.has(heygenTool), `ship lane must expose ${heygenTool}`);
  }
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

test('(d) cro connector gets only the fixed HeyGen direct/QA surface plus external reads', () => {
  const set = connectorToolset(testEnv(), 'cro');
  assert.deepEqual([...set].sort(), [...CRO_CONNECTOR_TOOLSET].sort());
  for (const required of [
    'heygen_account_get', 'heygen_avatar_groups_list', 'heygen_avatar_look_get',
    'heygen_avatar_video_create', 'heygen_owner_approval_status_get',
    'heygen_existing_video_ingest_qa', 'heygen_video_wait_ingest_qa',
    'heygen_reference_look_create', 'heygen_video_agent_session_create_preflight',
  ]) assert.ok(set.has(required), `cro connector must expose ${required}`);
  for (const forbidden of [
    'heygen_pairing_start', 'heygen_pairing_status', 'heygen_prompt_avatar_create',
    'heygen_avatar_look_name_update', 'github_push_files', 'kb_search_privileged',
  ]) assert.equal(set.has(forbidden), false, `cro connector must not expose ${forbidden}`);
});

test('(e) Wefunder Campaign Director gets only the external baseline plus bounded browser broker reads', () => {
  const set = connectorToolset(testEnv(), 'wefunder-campaign-director');
  assert.deepEqual([...set].sort(), [...WEFUNDER_CAMPAIGN_DIRECTOR_CONNECTOR_TOOLSET].sort());
  assert.ok(set.has('browser_broker_preflight'));
  assert.ok(set.has('browser_broker_inspect_public'));
  for (const forbidden of [
    'browser_agentcore_wefunder_preflight', 'github_push_files', 'kb_search_privileged',
    'memory_write', 'legal_blob_put', 'heygen_pairing_start',
  ]) assert.equal(set.has(forbidden), false, `Wefunder connector must not expose ${forbidden}`);
});

test("(f) 'external-read' lane set is EXACTLY the 11 read tools (incl. Phase 6 search/fetch) and excludes every privileged/write tool", () => {
  const set = connectorToolset(testEnv(), 'external-read');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
  assert.equal(set.size, 11);
  assert.ok(set.has('search'), 'external-read must see the OpenAI connector search tool');
  assert.ok(set.has('fetch'), 'external-read must see the OpenAI connector fetch tool');
  for (const forbidden of [
    'kb_search_privileged', 'kb_get_document', 'kb_get_sheet',
    'legal_blob_list', 'legal_blob_get', 'legal_blob_put',
    'memory_write', 'memory_remember',
    'github_push_files', 'github_merge_pull_request', 'github_create_pull_request',
    'azure_job_execute', 'azure_containerapp_set_env',
    'heygen_pairing_start', 'heygen_pairing_status', 'heygen_account_get',
    'heygen_videos_list', 'heygen_video_get', 'heygen_video_agent_styles_list',
    'heygen_avatar_groups_list', 'heygen_avatar_group_get', 'heygen_avatar_looks_list',
    'heygen_avatar_look_get', 'heygen_voices_list', 'heygen_voice_design', 'heygen_voice_get',
    'heygen_video_statuses_get', 'heygen_video_agent_sessions_list', 'heygen_video_agent_session_get',
    'heygen_video_agent_session_videos_list', 'heygen_brand_kits_list', 'heygen_brand_glossaries_list',
    'heygen_brand_glossary_get', 'heygen_translation_languages_list', 'heygen_translations_list',
    'heygen_translation_get', 'heygen_translation_statuses_get', 'heygen_proofread_get',
    'heygen_avatar_video_operation_get', 'heygen_owner_approval_status_get', 'heygen_prompt_avatar_create', 'heygen_avatar_video_create',
    'heygen_video_wait_ingest_qa',
  ]) {
    assert.equal(set.has(forbidden), false, `external-read must never see ${forbidden}`);
  }
});

test("(f) '' (empty/unknown caller) lane gets EXACTLY the external read set", () => {
  const set = connectorToolset(testEnv(), '');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
});

test("(g) an unrecognized lane string gets EXACTLY the external read set (regression guard for THE HOLE this closes)", () => {
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
