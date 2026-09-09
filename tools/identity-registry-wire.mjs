/**
 * Synthetic wire proof. Run with the source-registry checkout as its only argument:
 *   node tools/identity-registry-wire.mjs <source-registry-checkout>
 *
 * It dynamically loads the actual client and exporter. No service, CFO record, or
 * signing key is used. The authority callback below represents the required source
 * owner adapter: automatic source-version-bound records with explicit scoped IDs.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

for (const [name, value] of Object.entries({
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000',
  ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000',
  N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
})) process.env[name] ??= value;
const { graphWorkerBrokerTest: helper, registerGraphWorkerBrokerRoutes } =
  await import('../dist/server/graph-worker-broker.js');

const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('source_registry_checkout_required');
const source = resolve(sourceRoot);
const clientModule = await import(pathToFileURL(join(source,
  'tools/neptune-trial/source-identity-registry/gateway-client.mjs')).href);
const exporterModule = await import(pathToFileURL(join(source,
  'tools/neptune-trial/source-identity-registry/exporter.mjs')).href);
const H = helper.digest;
const authority = {
  schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'synthetic-cfo-source',
  source_system: 'synthetic-source-owner', scope: 'cfo', version: 'v1',
};
const runContent = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'company_graph_backfill',
  scope: 'finance', run_version: 'identity-wire-v1', manifest_sha256: H('identity-wire-manifest') };
const run = { ...runContent, run_id: 'run_' + H(helper.canonical(runContent)) };
const binding = { authenticated_caller: 'cfo', run, room: 'finance',
  source_index: 'finance-cfo-source-docs' };
const policy = { schema: 'graph-worker-bindings-v1', policy_version: 'identity-wire-policy-v1',
  expires_at: '2030-01-01T00:00:00.000Z', bindings: [binding] };
const state = { status: 'active', run, superseded_run: null, tombstone: null };
const active = { schema: 'neptune-trial-active-run-state-v1', state_sha256: H(helper.canonical(state)), state };
assert.ok(helper.parsePolicy(JSON.stringify(policy), Date.parse('2026-09-08T04:00:00.000Z')),
  'synthetic current gateway binding is valid');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const envelopes = new Map();
const revoked = new Set();
const filesystemMode = process.argv[3] === '--filesystem-store';
const s3Mode = process.argv[3] === '--s3-store';
const persistentMode = filesystemMode || s3Mode;
let storeDirectory, fileStore, createFileStore;
if (filesystemMode) {
  const { createIdentityRegistrySnapshotStore } = await import('./identity-registry-store.mjs');
  storeDirectory = await mkdtemp(join(tmpdir(), 'synthetic-identity-wire-'));
  createFileStore = () => createIdentityRegistrySnapshotStore({ rootDirectory: storeDirectory, allowNonDurableWindows: true });
  fileStore = await createFileStore();
}
if (s3Mode) {
  const { createIdentityRegistryS3SnapshotStore } = await import('./identity-registry-s3-store.mjs');
  const objects = new Map(); let revision = 0;
  const fetchImpl = async (urlText, init) => {
    const url = new URL(urlText), current = objects.get(url.pathname), pin = url.searchParams.get('versionId');
    const reply = (body, status, version) => new Response(body, { status, headers: version ? {
      'x-amz-version-id': version, 'x-amz-server-side-encryption': 'AES256' } : {} });
    if (init.method === 'GET') return current && (!pin || current.version === pin) ? reply(current.body, 200, current.version) : reply('', 404);
    if (init.method !== 'PUT' || new Headers(init.headers).get('if-none-match') !== '*') return reply('', 400);
    if (current) return reply('', 412);
    const item = { body: String(init.body), version: `synthetic-version-${++revision}` }; objects.set(url.pathname, item);
    return reply('', 200, item.version);
  };
  createFileStore = async () => createIdentityRegistryS3SnapshotStore({ bucket: 'synthetic-registry-store', prefix: 'synthetic/registry',
    region: 'us-east-1', sse: { algorithm: 'AES256' }, requestTimeoutMs: 1000, immutableTombstonePolicyAttested: true,
    signRequest: async request => ({ url: request.url, headers: request.headers }), fetchImpl });
  fileStore = await createFileStore();
}
const app = Fastify({ logger: false });
registerGraphWorkerBrokerRoutes(app, {
  authenticate: async () => ({ caller_hash: H('wire-caller'), raw_token: 'test-only', caller_agent: 'cfo',
    connector_surface: true, m365_static_auth: false }),
  bindingsJson: () => JSON.stringify(policy), now: () => Date.parse('2026-09-08T04:00:00.000Z'),
  resolveCohortBinding: async () => null,
  s3: async request => request.method === 'GET' && request.key ===
    helper.statePrefix(binding) + '/active-runs/' + helper.bindingHash(run) + '.json'
    ? { status: 200, headers: new Headers({ etag: '"synthetic"' }), body: Buffer.from(helper.canonical(active)) }
    : { status: 404, headers: new Headers(), body: Buffer.alloc(0) },
  readCfoText: async () => { throw new Error('identity_routes_do_not_read_cfo_text'); },
  identityRegistry: {
    resolve: async ({ registry_id, caller }) => registry_id === 'cfo-registry' && caller.caller_agent === 'cfo' ? {
      registry_id, authority, binding,
      public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      source: {
        page: async () => ({ schema: 'structured-identity-source-page-v1', authority, current: true,
          source_version: 'source-version-1', next_cursor: null, records: [{
            source_record_id: 'source-record-1', source_document_version: 'document-version-1',
            source_sha256: H('source-record-1'), mention: 'Synthetic Co', disposition: 'resolved',
            endpoint: { display_name: 'Synthetic Co', entity_type: 'company',
              identifier: { namespace: 'source-owner', scope: 'synthetic-cfo', value: 'company-001' } },
          }, {
            source_record_id: 'source-record-ambiguous', source_document_version: 'document-version-1',
            source_sha256: H('source-record-ambiguous'), mention: 'Ambiguous Co', disposition: 'unresolved',
          }] }),
        current: async ({ source_version }) => source_version === 'source-version-1',
      },
      snapshots: {
        publish: async ({ registry_id, version, envelope }, options) => {
          if (persistentMode) return fileStore.publish({ registry_id, version, envelope }, options);
          if (envelopes.has(version)) return false;
          envelopes.set(version, envelope); return true;
        },
        read: async ({ registry_id, version }, options) => persistentMode ? fileStore.read({ registry_id, version }, options) : revoked.has(version) ? { status: 'revoked' } :
          envelopes.has(version) ? { status: 'active', envelope: envelopes.get(version) } : { status: 'missing' },
      },
    } : null,
  },
});
await app.ready();
try {
  const transport = async (url, init) => {
    const parsed = new URL(url);
    const response = await app.inject({ method: init.method, url: parsed.pathname,
      headers: Object.fromEntries(new Headers(init.headers).entries()), payload: init.body });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const gateway = clientModule.createGatewayIdentityRegistryClient({ registryId: 'cfo-registry', authority,
    callerSeat: 'cfo', bearerTokenProvider: async () => 'synthetic-token', transport });
  const adapter = exporterModule.createAuthenticatedStructuredIdentityAdapter({ authority, callerSeat: 'cfo',
    authorize: gateway.authorize, listPage: gateway.listPage, assertCurrent: gateway.assertCurrent });
  const grant = await gateway.authorize({ schema: exporterModule.AUTHORIZATION_SCHEMA, action: 'read_page',
    authenticated_caller: 'cfo', authority, cursor: null, source_version: null });
  await assert.rejects(gateway.listPage({ authority, cursor: null, source_version: null, page_size: 1,
    authorization: { decision_ref: grant.decision_ref, policy_version: grant.policy_version } }),
    error => error.code === 'identity_gateway_source_unavailable');
  const exporter = exporterModule.createSourceIdentityRegistryExporter({ registryId: 'cfo-registry', adapter,
    signer: { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId: 'synthetic-ed25519', sign: async ({ payload }) =>
      sign(null, payload, privateKey).toString('base64') } });
  const envelope = await exporter.exportSnapshot();
  assert.equal(envelope.snapshot.entries.length, 1, 'ambiguous source record was not exported');
  const receipt = await gateway.publish(envelope);
  assert.equal(receipt.version, envelope.snapshot.version);
  if (persistentMode) fileStore = await createFileStore();
  assert.deepEqual(await gateway.readSnapshot({ registry_id: 'cfo-registry', version: envelope.snapshot.version }), envelope);
  if (persistentMode) {
    await fileStore.revoke({ registry_id: 'cfo-registry', version: envelope.snapshot.version });
    fileStore = await createFileStore();
  } else revoked.add(envelope.snapshot.version);
  await assert.rejects(() => gateway.readSnapshot({ registry_id: 'cfo-registry', version: envelope.snapshot.version }),
    error => error.code === 'identity_registry_version_revoked');
  process.stdout.write(JSON.stringify({ wire: 'identity-registry', published: true, revoked_read_denied: true,
    filesystem_reopen: filesystemMode, s3_replica_recreated: s3Mode, real_aws_calls: 0,
    process_restart_verified: false, power_loss_durability_verified: false }) + '\n');
} finally {
  await app.close();
  if (storeDirectory) {
    if (dirname(resolve(storeDirectory)) !== resolve(tmpdir())) throw Error('synthetic_cleanup_path_invalid');
    await rm(storeDirectory, { recursive: true, force: true });
  }
}
