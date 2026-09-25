import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { connectorToolset, isShipLane, CTO_SHIP_LANE_TOOLSET, CRO_CONNECTOR_TOOLSET, COO_CONNECTOR_TOOLSET, EXTERNAL_READONLY_TOOLSET, WEFUNDER_CAMPAIGN_DIRECTOR_CONNECTOR_TOOLSET } from './registry.js';
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

const CLOUD_BROWSER_TOOLS = ['browser_cloud_profile_discover', 'browser_cloud_session_start', 'browser_cloud_session_action',
  'browser_cloud_session_snapshot', 'browser_cloud_profile_save', 'browser_cloud_session_stop',
  'browser_cloud_job_submit', 'browser_cloud_job_get', 'browser_cloud_job_cancel', 'browser_cloud_artifact_get'];
const CTO_CLOUD_BROWSER_PROVISIONING_TOOL = 'browser_cloud_profile_provision_public_trial';
const CTO_ONLY_GITHUB_RECEIPT_TOOL = 'github_graphrag_observation_receipt_get';
const RESTRICTED_GITHUB_MAKE_BROKER_TOOL = 'github_make_broker';
function testEnv(): Env {
  return loadEnv();
}

test('CTO_SHIP_LANE_TOOLSET and EXTERNAL_READONLY_TOOLSET are disjoint from each other in intent: the external set is a strict, minimal subset of tool names', () => {
  // Sanity check on the fixtures themselves before testing the routing that hands them out.
  // 9 original read tools + Phase 6's search/fetch (OpenAI connector contract) = 11, + Task G-3's
  // web_research/web_extract (2026-09-03, the same read-only exposure web_search already has) = 13.
  assert.equal(EXTERNAL_READONLY_TOOLSET.length, 13);
  for (const name of EXTERNAL_READONLY_TOOLSET) {
    assert.ok(CTO_SHIP_LANE_TOOLSET.includes(name), `${name} should also be reachable on the ship lane`);
  }
});

test('(a) cto lane gets the full ship-lane set, including the privileged tools', () => {
  const set = connectorToolset(testEnv(), 'cto');
  assert.deepEqual([...set].sort(), [...CTO_SHIP_LANE_TOOLSET, ...CLOUD_BROWSER_TOOLS, CTO_CLOUD_BROWSER_PROVISIONING_TOOL, 'hyperagent_discover_capabilities', CTO_ONLY_GITHUB_RECEIPT_TOOL, RESTRICTED_GITHUB_MAKE_BROKER_TOOL].sort());
  assert.ok(set.has(CTO_CLOUD_BROWSER_PROVISIONING_TOOL), 'CTO connector must expose the protected public-profile provisioner');
  assert.ok(set.has('kb_search_privileged'));
  assert.ok(set.has('memory_write'));
  assert.ok(set.has('brain_graph_search'), 'CTO connector must expose company-scoped GraphRAG');
  assert.ok(set.has(CTO_ONLY_GITHUB_RECEIPT_TOOL), 'CTO connector must expose the fixed observation receipt reader');
  assert.ok(set.has(RESTRICTED_GITHUB_MAKE_BROKER_TOOL), 'CTO connector must expose the fixed GitHub Make pilot broker');
  // Regression guard (Task G-3, 2026-09-03): web_research/web_extract were added in the SAME
  // change that registers them, so they can't repeat the exact omission class every other guard on
  // this page documents (built + registered but invisible on every connector).
  assert.ok(set.has('web_research'), 'ship lane must expose web_research');
  assert.ok(set.has('web_extract'), 'ship lane must expose web_extract');
  // Regression guard (2026-07-17): the CFO reported kb_get_document was invisible on its DCR
  // connector because #130 shipped the tool into the catalog but never added it to this ship set.
  assert.ok(set.has('kb_get_document'), 'ship lane must expose whole-doc retrieval (the CFO census gap)');
  // Regression guard (2026-07-30, P0-1): the CFO reported xero_attachment_upload was invisible on
  // its connector even though it was fully built, registered, and reachable via a direct minted-
  // token MCP call -- it was simply never added to this ship set (its read-side sibling
  // xero_attachments was, since day one). Also assert every OTHER xero_* tool the CFO actually
  // depends on stays present, so a future edit here can't silently drop one again.
  assert.ok(set.has('xero_attachment_upload'), 'ship lane must expose xero attachment upload (the CFO round-trip-verification gap)');
  for (const xeroTool of ['xero_attachments', 'xero_request', 'xero_accounts', 'xero_get']) {
    assert.ok(set.has(xeroTool), `ship lane must still expose ${xeroTool}`);
  }
  // Regression guard (this build): xero_attachment_content -- the READ counterpart to
  // xero_attachment_upload above. xero_attachments only ever listed metadata; before this tool no
  // path could fetch an attachment's actual bytes at all. Pinned by name, added in the SAME change
  // that registers the tool, so it can never repeat the exact omission class every guard on this
  // page already documents.
  assert.ok(set.has('xero_attachment_content'), 'ship lane must expose xero_attachment_content (fetching real attachment bytes, not just metadata)');
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
  // Hyperagent broker: all five wrappers already enforce the caller lane and agent class in
  // hyperagent/ring.ts. This guard prevents them from being globally registered but invisible to
  // the connector-surface CTO seat again.
  for (const hyperagentTool of [
    'hyperagent_list_agents', 'hyperagent_list_threads', 'hyperagent_get_thread',
    'hyperagent_create_thread', 'hyperagent_send_message',
  ]) assert.ok(set.has(hyperagentTool), `ship lane must expose ${hyperagentTool}`);
  assert.ok(set.has('hyperagent_discover_capabilities'), 'CTO connector must expose fixed Hyperagent schema discovery');
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

test('the fixed observation receipt is CTO-only; the Make broker is CTO/pilot-only, not shared ship lanes', () => {
  assert.equal(CTO_SHIP_LANE_TOOLSET.includes(CTO_ONLY_GITHUB_RECEIPT_TOOL), false, 'CTO-only receipt must not be in the shared ship set');
  assert.equal(CTO_SHIP_LANE_TOOLSET.includes(RESTRICTED_GITHUB_MAKE_BROKER_TOOL), false, 'Make broker must not be in the shared ship set');
  assert.equal(connectorToolset(testEnv(), 'cto').has(CTO_ONLY_GITHUB_RECEIPT_TOOL), true);
  assert.equal(connectorToolset(testEnv(), 'cto').has(RESTRICTED_GITHUB_MAKE_BROKER_TOOL), true);
  assert.equal(connectorToolset(testEnv(), 'cto-make-github-pilot').has(CTO_ONLY_GITHUB_RECEIPT_TOOL), false);
  assert.equal(connectorToolset(testEnv(), 'cto-make-github-pilot').has(RESTRICTED_GITHUB_MAKE_BROKER_TOOL), true);
  for (const lane of ['developer', 'exec', 'cfo', 'clo', 'clo-personal', 'cpo', 'cco', 'cro', 'coo', 'wefunder-campaign-director', 'external-read', 'unknown']) {
    assert.equal(connectorToolset(testEnv(), lane).has(CTO_ONLY_GITHUB_RECEIPT_TOOL), false, `${lane} connector must not advertise the CTO-only receipt`);
    assert.equal(connectorToolset(testEnv(), lane).has(RESTRICTED_GITHUB_MAKE_BROKER_TOOL), false, `${lane} connector must not advertise the restricted Make broker`);
  }
  const overridden = { ...testEnv(), CONNECTOR_TOOLSET: `${CTO_ONLY_GITHUB_RECEIPT_TOOL},${RESTRICTED_GITHUB_MAKE_BROKER_TOOL}` } as Env;
  assert.equal(connectorToolset(overridden, 'developer').has(CTO_ONLY_GITHUB_RECEIPT_TOOL), false, 'a shared override must not leak the CTO-only receipt');
  assert.equal(connectorToolset(overridden, 'developer').has(RESTRICTED_GITHUB_MAKE_BROKER_TOOL), false, 'a shared override must not leak the restricted Make broker');
});

test('the Make pilot identity gets exactly the broker and catalog probe even under a global connector override', () => {
  const expected = ['catalog_probe', 'github_make_broker'];
  const standard = connectorToolset(testEnv(), 'cto-make-github-pilot');
  assert.deepEqual([...standard].sort(), expected);
  assert.equal(isShipLane('cto-make-github-pilot'), false, 'the pilot is not a ship or executive-ring lane');
  assert.equal((EXEC_RING as readonly string[]).includes('cto-make-github-pilot'), false, 'the pilot must not enter the protected ring');

  const overridden = {
    ...testEnv(),
    CONNECTOR_TOOLSET: 'github_make_broker,catalog_probe,github_push_files,gateway_fetch_result,kb_search_privileged,legal_blob_get,memory_remember',
  } as Env;
  assert.deepEqual([...connectorToolset(overridden, 'cto-make-github-pilot')].sort(), expected);
});

test('(b) developer lane gets the full ship-lane set', () => {
  const set = connectorToolset(testEnv(), 'developer');
  assert.deepEqual([...set].sort(), [...CTO_SHIP_LANE_TOOLSET, ...CLOUD_BROWSER_TOOLS].sort());
  assert.equal(set.has(CTO_CLOUD_BROWSER_PROVISIONING_TOOL), false);
  assert.ok(set.has('brain_graph_search'));
});

test('(c) every EXEC_RING lane gets the full ship-lane set', () => {
  const env = testEnv();
  for (const lane of EXEC_RING) {
    const set = connectorToolset(env, lane);
    assert.deepEqual([...set].sort(), [...CTO_SHIP_LANE_TOOLSET, ...(['cfo', 'clo'].includes(lane) ? CLOUD_BROWSER_TOOLS : [])].sort(), `${lane} should get the ship set`);
    assert.ok(set.has('brain_graph_search'), `${lane} should expose GraphRAG`);
  }
});

test('(d) cro connector gets only the fixed HeyGen direct/QA surface plus external reads', () => {
  const set = connectorToolset(testEnv(), 'cro');
  assert.deepEqual([...set].sort(), [...CRO_CONNECTOR_TOOLSET, ...CLOUD_BROWSER_TOOLS].sort());
  for (const required of [
    'heygen_account_get', 'heygen_avatar_groups_list', 'heygen_avatar_look_get',
    'heygen_avatar_video_create', 'heygen_owner_approval_status_get',
    'heygen_existing_video_ingest_qa', 'heygen_video_wait_ingest_qa',
    'heygen_reference_look_create', 'heygen_video_agent_session_create_preflight',
    'shopify_location_list', 'cio_admin_read_workspace_health',
  ]) assert.ok(set.has(required), `cro connector must expose ${required}`);
  for (const forbidden of [
    'heygen_pairing_start', 'heygen_pairing_status', 'heygen_prompt_avatar_create',
    'heygen_avatar_look_name_update', 'github_push_files', 'kb_search_privileged',
    'cio_admin_write_frequency_cap_delete', 'shopify_refund_create',
  ]) assert.equal(set.has(forbidden), false, `cro connector must not expose ${forbidden}`);
});

test('(e) Wefunder Campaign Director gets exact-source migration tools with owner-bound cloud browsing and without private-data grants', () => {
  const set = connectorToolset(testEnv(), 'wefunder-campaign-director');
  assert.deepEqual([...set].sort(), [...WEFUNDER_CAMPAIGN_DIRECTOR_CONNECTOR_TOOLSET, ...CLOUD_BROWSER_TOOLS].sort());
  assert.ok(set.has('browser_broker_preflight'));
  assert.ok(set.has('browser_broker_inspect_public'));
  for (const required of ['catalog_probe', 'hyperagent_list_agents', 'hyperagent_list_threads',
    'hyperagent_get_thread', 'hyperagent_create_thread', 'hyperagent_send_message']) {
    assert.ok(set.has(required), required);
  }
  assert.equal(isShipLane('wefunder-campaign-director'), false);
  for (const forbidden of [
    'browser_agentcore_wefunder_preflight', 'github_push_files', 'kb_search_privileged',
    'memory_write', 'memory_remember', 'checkpoint', 'legal_blob_put', 'legal_blob_get',
    'kb_get_document', 'kb_list_documents', 'xero_manual_journals', 'heygen_pairing_start', 'gateway_fetch_result',
    'shopify_location_list', 'cio_admin_read_workspace_health',
  ]) assert.equal(set.has(forbidden), false, `Wefunder connector must not expose ${forbidden}`);
});

test('(f) Hyperagent schema discovery is only advertised to the CTO connector', () => {
  assert.equal(connectorToolset(testEnv(), 'cto').has('hyperagent_discover_capabilities'), true);
  for (const lane of ['developer', 'exec', 'cfo', 'clo', 'coo', 'cro', 'wefunder-campaign-director']) {
    assert.equal(connectorToolset(testEnv(), lane).has('hyperagent_discover_capabilities'), false, lane);
  }
});

test("(f) 'external-read' lane set is EXACTLY the 13 read tools (incl. Phase 6 search/fetch and Task G-3's web_research/web_extract) and excludes every privileged/write tool", () => {
  const set = connectorToolset(testEnv(), 'external-read');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
  assert.equal(set.size, 13);
  assert.ok(set.has('search'), 'external-read must see the OpenAI connector search tool');
  assert.ok(set.has('fetch'), 'external-read must see the OpenAI connector fetch tool');
  assert.ok(set.has('web_research'), 'external-read must see web_research (same exposure as web_search)');
  assert.ok(set.has('web_extract'), 'external-read must see web_extract (same exposure as web_search)');
  for (const forbidden of [
    'kb_search_privileged', 'kb_get_document',
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

test('cfo connector keeps its bounded relationship query through ship-set curation', () => {
  const set = connectorToolset(testEnv(), 'cfo');
  assert.ok(set.has('graph_relationship_query'));
  assert.equal(connectorToolset(testEnv(), 'external-read').has('graph_relationship_query'), false);
});

// ── 2026-08-29: role-elevated connector seat curation (COO + CRO), found by LIVE tools/list probe ──
// After the URL-only owner-code elevation shipped, a live probe showed an elevated coo connector
// advertising only the 11-tool external read set -- its instruction block's own verbs (memory_team,
// memory_remember, checkpoint) were unfindable, and cro's surface carried HeyGen but none of the
// commerce families its charter names. These tests lock the fixed seat surfaces AND their ceilings.

test('coo lane: seat-memory + ledger coordination, and nothing privileged', () => {
  const set = connectorToolset(testEnv(), 'coo');
  assert.deepEqual([...set].sort(), [...COO_CONNECTOR_TOOLSET, ...CLOUD_BROWSER_TOOLS].sort());
  for (const needed of ['memory_team', 'memory_remember', 'memory_pack', 'checkpoint', 'incident_match', 'task_list', 'task_create', 'task_claim', 'task_update', 'task_heartbeat', 'task_complete', 'agent_dispatch', 'inbox_read', 'brain_search', 'brain_graph_search', 'catalog_probe', 'search', 'fetch']) {
    assert.ok(set.has(needed), `coo connector must advertise ${needed} (its instruction block names it)`);
  }
  for (const excluded of ['kb_search_privileged', 'legal_blob_list', 'legal_blob_put', 'xero_orgs', 'shopify_list_products', 'shopify_location_list', 'github_merge_pull_request', 'memory_write', 'cio_send_transactional', 'cio_admin_read_workspace_health', 'graph_send_email']) {
    assert.equal(set.has(excluded), false, `coo connector must NOT advertise ${excluded}`);
  }
});

test('cro lane: commerce curation present, engineering/legal/finance/privileged absent, destructive commerce absent', () => {
  const set = connectorToolset(testEnv(), 'cro');
  assert.deepEqual([...set].sort(), [...CRO_CONNECTOR_TOOLSET, ...CLOUD_BROWSER_TOOLS].sort());
  for (const needed of ['shopify_list_products', 'shopify_create_draft_order', 'shopify_create_discount_code', 'cio_campaign_list', 'cio_track_event', 'intercom_conversation_search', 'revenuecat_list_projects', 'stripe_get_balance', 'memory_team', 'memory_remember', 'checkpoint', 'task_claim', 'task_heartbeat', 'task_complete', 'brain_graph_search', 'catalog_probe', 'heygen_videos_list']) {
    assert.ok(set.has(needed), `cro connector must advertise ${needed} (its charter names this family)`);
  }
  for (const excluded of ['kb_search_privileged', 'legal_blob_list', 'xero_orgs', 'github_merge_pull_request', 'memory_write', 'shopify_product_delete', 'shopify_order_cancel', 'shopify_refund_create', 'cio_send_transactional', 'cio_admin_write_frequency_cap_delete', 'cio_delete_customer', 'cio_suppress_customer', 'stripe_create_refund', 'stripe_payout_create', 'twilio_send_sms', 'graph_send_email']) {
    assert.equal(set.has(excluded), false, `cro connector must NOT advertise ${excluded}`);
  }
});

test('the seat additions never leak into the plain external/unknown lane', () => {
  const set = connectorToolset(testEnv(), 'totally-unknown-lane');
  assert.deepEqual([...set].sort(), [...EXTERNAL_READONLY_TOOLSET].sort());
  for (const seatOnly of [
    'memory_team', 'memory_remember', 'checkpoint', 'task_create', 'task_claim', 'task_heartbeat', 'task_complete', 'shopify_list_products',
    'shopify_location_list', 'cio_track_event', 'cio_admin_read_workspace_health', 'hyperagent_list_agents', 'hyperagent_create_thread',
  ]) {
    assert.equal(set.has(seatOnly), false, `external lane must NOT gain ${seatOnly}`);
  }
  const wefunder = connectorToolset(testEnv(), 'wefunder-campaign-director');
  for (const seatOnly of ['task_claim', 'task_heartbeat', 'task_complete']) {
    assert.equal(wefunder.has(seatOnly), false, `WeFunder lane must NOT gain ${seatOnly}`);
  }
});

test('ship lanes advertise connector_setup_code_create (execution stays cto/exec-gated in-handler)', () => {
  const set = connectorToolset(testEnv(), 'cto');
  assert.ok(set.has('connector_setup_code_create'));
  for (const lane of ['coo', 'cro', 'totally-unknown-lane']) {
    assert.equal(connectorToolset(testEnv(), lane).has('connector_setup_code_create'), false, `${lane} must not advertise setup-code minting`);
  }
});
