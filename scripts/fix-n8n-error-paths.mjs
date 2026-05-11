// One-shot script: harden the two MCP-orchestrated workflows in n8n by
// (a) preventing HTTP Request nodes from halting on 4xx/5xx (onError +
// ignoreHttpStatusErrors), and (b) inserting a "Build response" Code node
// before each Respond OK that constructs success/error bodies based on
// upstream HTTP status codes. The Respond OK node simplifies to returning
// the pre-built body verbatim.
//
// Run: node scripts/fix-n8n-error-paths.mjs
// Reads N8N_API_KEY + N8N_BASE_URL from the local .env.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

function loadDotEnv(path) {
  const out = {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const env = loadDotEnv(envPath);
const N8N_KEY = env.N8N_API_KEY || process.env.N8N_API_KEY;
const N8N_BASE = (env.N8N_BASE_URL || process.env.N8N_BASE_URL || 'https://otchealth.app.n8n.cloud').replace(/\/$/, '') + '/api/v1';

if (!N8N_KEY) {
  console.error('Missing N8N_API_KEY in .env');
  process.exit(1);
}

const HEADERS = {
  'X-N8N-API-KEY': N8N_KEY,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

const WORKFLOWS = [
  {
    id: 'TDK44BjKZCDn9whz',
    name: 'OTCHealth MCP - cio_update_newsletter_variant',
    fetchNodeName: 'Fetch current newsletter (for diff)',
    mutateNodeName: 'PATCH newsletter variant (allowlisted fields only)',
    respondOkNodeName: 'Respond OK (200)',
    buildSuccessLogic: `
const fetched = $('Fetch current newsletter (for diff)').first().json;
const patched = $json;
const fetchStatus = (fetched && fetched.statusCode) || 200;
const patchStatus = (patched && patched.statusCode) || 200;
const fields = $('Verify HMAC-SHA256').first().json.body.fields;
if (fetchStatus < 200 || fetchStatus >= 300) {
  return [{ json: { _httpStatus: 502, success: false, error: 'cio_fetch_failed', upstream_status: fetchStatus, upstream: fetched, audit_payload: { before: null, after: null } } }];
}
if (patchStatus < 200 || patchStatus >= 300) {
  return [{ json: { _httpStatus: 502, success: false, error: 'cio_patch_failed', upstream_status: patchStatus, upstream: patched, audit_payload: { before: fetched, after: null } } }];
}
return [{ json: { _httpStatus: 200, success: true, result: { upstream: patched }, audit_payload: { before: fetched, after: fields } } }];
`.trim(),
  },
  {
    id: 'dAiTd4lFi3AbfdWo',
    name: 'OTCHealth MCP - cio_duplicate_newsletter',
    duplicateNodeName: 'POST /newsletters/{id}/duplicate (best-effort)',
    respondOkNodeName: 'Respond OK (200)',
    respondUnsupportedNodeName: 'Respond unsupported_via_api',
    buildSuccessLogic: `
const dup = $json;
const status = (dup && dup.statusCode) || 200;
const sourceSnapshot = $('Verify HMAC-SHA256').first().json.body.source_snapshot;
if (status === 404 || status === 405) {
  return [{ json: { _httpStatus: 200, success: false, result: { new_newsletter_id: null, status: 'unsupported_via_api' }, error: 'Customer.io did not accept POST /newsletters/{id}/duplicate. Manual duplication in the UI is required.', audit_payload: { before: sourceSnapshot, after: null } } }];
}
if (status < 200 || status >= 300) {
  return [{ json: { _httpStatus: 502, success: false, error: 'cio_duplicate_failed', upstream_status: status, upstream: dup, audit_payload: { before: sourceSnapshot, after: null } } }];
}
const newId = (dup && (dup.id || (dup.newsletter && dup.newsletter.id))) || null;
return [{ json: { _httpStatus: 200, success: true, result: { new_newsletter_id: newId, status: 'ok' }, audit_payload: { before: sourceSnapshot, after: dup } } }];
`.trim(),
  },
];

async function gqlFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

function findNode(wf, name) {
  return wf.nodes.find((n) => n.name === name);
}

function newId() {
  // crypto.randomUUID is available in Node 18+
  return crypto.randomUUID();
}

function ensureContinueOnFail(node) {
  node.onError = 'continueRegularOutput';
  node.parameters = node.parameters || {};
  node.parameters.options = node.parameters.options || {};
  node.parameters.options.ignoreHttpStatusErrors = true;
}

function rewireConnection(connections, fromName, toReplaceName, newToName) {
  const out = connections[fromName];
  if (!out || !out.main) return;
  for (const outputArr of out.main) {
    if (!Array.isArray(outputArr)) continue;
    for (const conn of outputArr) {
      if (conn.node === toReplaceName) conn.node = newToName;
    }
  }
}

async function patchUpdateVariantWorkflow(spec) {
  console.log(`\n=== ${spec.name} (${spec.id}) ===`);
  const wf = await gqlFetch(`${N8N_BASE}/workflows/${spec.id}`);

  // 1. Harden HTTP Request nodes
  const fetchNode = findNode(wf, spec.fetchNodeName);
  const mutateNode = findNode(wf, spec.mutateNodeName);
  if (!fetchNode || !mutateNode) {
    console.log('  !! could not find expected HTTP nodes; aborting this workflow');
    return;
  }
  ensureContinueOnFail(fetchNode);
  ensureContinueOnFail(mutateNode);
  console.log('  hardened HTTP nodes:', fetchNode.name, '+', mutateNode.name);

  // 2. Insert "Build response" Code node between mutate and respond OK
  const respondOkNode = findNode(wf, spec.respondOkNodeName);
  if (!respondOkNode) {
    console.log('  !! could not find', spec.respondOkNodeName);
    return;
  }
  const buildNodeName = 'Build response';
  let buildNode = findNode(wf, buildNodeName);
  if (!buildNode) {
    buildNode = {
      id: newId(),
      name: buildNodeName,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [Math.round(respondOkNode.position[0] - 110), respondOkNode.position[1]],
      parameters: {
        language: 'javaScript',
        jsCode: spec.buildSuccessLogic,
      },
    };
    wf.nodes.push(buildNode);
    console.log('  inserted "Build response" Code node');
  } else {
    buildNode.parameters.jsCode = spec.buildSuccessLogic;
    console.log('  refreshed "Build response" Code node logic');
  }

  // 3. Update Respond OK to return the pre-built body
  respondOkNode.parameters = respondOkNode.parameters || {};
  respondOkNode.parameters.respondWith = 'json';
  respondOkNode.parameters.responseBody = '={{ JSON.stringify($json) }}';
  delete respondOkNode.parameters.responseCode;
  console.log('  simplified', spec.respondOkNodeName, 'to relay pre-built body');

  // 4. Rewire connection mutate → Respond OK to mutate → Build response → Respond OK
  rewireConnection(wf.connections, spec.mutateNodeName, spec.respondOkNodeName, buildNodeName);
  wf.connections[buildNodeName] = wf.connections[buildNodeName] || {
    main: [[{ node: spec.respondOkNodeName, type: 'main', index: 0 }]],
  };
  console.log('  rewired:', spec.mutateNodeName, '→', buildNodeName, '→', spec.respondOkNodeName);

  return putWorkflow(wf);
}

async function patchDuplicateWorkflow(spec) {
  console.log(`\n=== ${spec.name} (${spec.id}) ===`);
  const wf = await gqlFetch(`${N8N_BASE}/workflows/${spec.id}`);

  const dupNode = findNode(wf, spec.duplicateNodeName);
  if (!dupNode) {
    console.log('  !! could not find', spec.duplicateNodeName);
    return;
  }
  ensureContinueOnFail(dupNode);
  console.log('  hardened HTTP node:', dupNode.name);

  // Insert a single "Build response" before Respond OK; replace both
  // Respond OK and Respond unsupported paths with this one structured path.
  const respondOkNode = findNode(wf, spec.respondOkNodeName);
  const respondUnsupportedNode = findNode(wf, spec.respondUnsupportedNodeName);

  const buildNodeName = 'Build response';
  let buildNode = findNode(wf, buildNodeName);
  if (!buildNode) {
    buildNode = {
      id: newId(),
      name: buildNodeName,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: respondOkNode ? [Math.round(respondOkNode.position[0] - 110), respondOkNode.position[1]] : [1240, 200],
      parameters: {
        language: 'javaScript',
        jsCode: spec.buildSuccessLogic,
      },
    };
    wf.nodes.push(buildNode);
    console.log('  inserted "Build response" Code node');
  } else {
    buildNode.parameters.jsCode = spec.buildSuccessLogic;
    console.log('  refreshed "Build response" Code node logic');
  }

  if (respondOkNode) {
    respondOkNode.parameters = respondOkNode.parameters || {};
    respondOkNode.parameters.respondWith = 'json';
    respondOkNode.parameters.responseBody = '={{ JSON.stringify($json) }}';
    delete respondOkNode.parameters.responseCode;
    console.log('  simplified', spec.respondOkNodeName);
  }

  // Rewire: duplicate -> Build response -> Respond OK
  // The "Endpoint supported?" IF node currently branches between Respond OK and Respond unsupported.
  // Simpler: bypass the IF entirely — connect duplicate -> Build response directly. Build response handles
  // the unsupported case in its JS logic now.
  const checkNodeName = 'Endpoint supported?';
  const checkNode = findNode(wf, checkNodeName);

  // Reconnect dup -> Build response
  wf.connections[spec.duplicateNodeName] = {
    main: [[{ node: buildNodeName, type: 'main', index: 0 }]],
  };
  wf.connections[buildNodeName] = {
    main: [[{ node: spec.respondOkNodeName, type: 'main', index: 0 }]],
  };

  // Disconnect the now-orphaned IF and unsupported nodes (we'll leave the nodes for inspection but they won't run)
  if (checkNode) delete wf.connections[checkNodeName];
  console.log('  rewired:', spec.duplicateNodeName, '→', buildNodeName, '→', spec.respondOkNodeName);
  console.log('  orphaned (kept but unused):', checkNodeName + ',', spec.respondUnsupportedNodeName);

  return putWorkflow(wf);
}

async function putWorkflow(wf) {
  // n8n PUT requires stripping read-only fields
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings || { executionOrder: 'v1' },
  };
  const res = await fetch(`${N8N_BASE}/workflows/${wf.id}`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`  PUT FAIL (${res.status}):`, text.slice(0, 400));
    return false;
  }
  console.log(`  PUT OK (${res.status})`);
  return true;
}

async function main() {
  await patchUpdateVariantWorkflow(WORKFLOWS[0]);
  await patchDuplicateWorkflow(WORKFLOWS[1]);
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
