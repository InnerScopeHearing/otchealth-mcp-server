// Normal production composition with synthetic source exports and S3 only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { createIdentityRegistrySourceAuthorityFixture, canonicalJson } from './identity-registry-source-authority.fixture.mjs';
import { createProductionIdentityRegistryResolver } from '../../dist/server/identity-registry-production.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const bucket = 'otchealth-finance-legal-dr-55c84f6b', prefix = 'graph-trial/registry-store';
const resource = `arn:aws:s3:::${bucket}/${prefix}/identity-registries/*`;
const policy = { Version: '2012-10-17', Statement: [
  { Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'], Resource: resource },
  { Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: resource, Condition: { Null: { 's3:if-none-match': 'true' } } },
] };
const policyHash = hash(policy), scopeHash = hash({ bucket, prefix, policy_sha256: policyHash });
const context = { caller_agent: 'cfo', caller_hash: hash('synthetic-cfo'), raw_token: 'synthetic-only', connector_surface: true, m365_static_auth: false };
const environment = {
  AWS_ACCESS_KEY_ID: 'synthetic-only-access', AWS_SECRET_ACCESS_KEY: 'synthetic-only-secret', AWS_SESSION_TOKEN: '',
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000', ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000',
  N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
};
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const originalFetch = globalThis.fetch;
let realCalls = 0;
try {
  const { registerGraphWorkerBrokerRoutes, graphWorkerBrokerTest: helper } = await import('../../dist/server/graph-worker-broker.js');
  assert.match(readFileSync(new URL('../../src/server/index.ts', import.meta.url), 'utf8'),
    /registerGraphWorkerBrokerRoutes\(app, \{ identityRegistry: createProductionIdentityRegistryResolver\(\) \}\)/);
  assert.equal(createProductionIdentityRegistryResolver(''), undefined);
  for (const mode of ['valid', 'malformed-resolved', 'malformed-unresolved', 'malformed-revoked']) {
    const f = createIdentityRegistrySourceAuthorityFixture();
    if (mode !== 'valid') {
      const descriptor = f.manifest.snapshot.pages[0];
      const page = structuredClone(f.page);
      page.records[0].disposition = mode.slice('malformed-'.length);
      delete page.records[0].source_record_id;
      const pageBody = Buffer.from(canonicalJson(page));
      descriptor.sha256 = hash(pageBody.toString());
      f.wireObjects.set(descriptor.key, { value: page, version_id: descriptor.version_id, body: pageBody, sha256: descriptor.sha256 });
      const { schema, version, ...unsigned } = f.manifest.snapshot;
      const manifest = f.sign({ schema, ...unsigned, version: 'siex_' + hash(unsigned) });
      const manifestBody = Buffer.from(canonicalJson(manifest));
      f.config.manifest.sha256 = hash(manifestBody.toString());
      f.wireObjects.set(f.config.manifest.key, { value: manifest, version_id: f.config.manifest.version_id, body: manifestBody, sha256: f.config.manifest.sha256 });
      f.setPointer(f.sign({ ...f.pointer.snapshot, manifest_version: manifest.snapshot.version }));
    }
    const storageObjects = new Map();
    let revision = 0, writes = 0, policyChanged = false, pinnedReads = 0;
    globalThis.fetch = async (urlText, init) => {
      const url = new URL(urlText);
      assert.equal(url.hostname, `${bucket}.s3.us-east-1.amazonaws.com`);
      assert.equal(init.redirect, 'error');
      assert.match(new Headers(init.headers).get('authorization'), /^AWS4-HMAC-SHA256 /);
      if (url.searchParams.has('versioning')) return new Response('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>');
      if (url.searchParams.has('policy')) return new Response(canonicalJson(policyChanged ? { Statement: [] } : policy));
      const key = url.pathname.slice(1), wanted = url.searchParams.get('versionId');
      if (wanted) pinnedReads++;
      const source = f.wireObjects.get(key);
      if (source) {
        assert.equal(init.method, 'GET');
        return !wanted || wanted === source.version_id ? new Response(source.body, { headers: {
          'x-amz-version-id': source.version_id, 'x-amz-server-side-encryption': 'AES256',
        } }) : new Response('', { status: 404 });
      }
      assert.ok(key.startsWith(prefix + '/'), 'transport cannot escape configured metadata prefixes');
      const item = storageObjects.get(key);
      if (init.method === 'GET') return item && (!wanted || wanted === item.version) ? new Response(item.body, { headers: {
        'x-amz-version-id': item.version, 'x-amz-server-side-encryption': 'AES256',
      } }) : new Response('', { status: 404 });
      assert.equal(init.method, 'PUT');
      assert.equal(new Headers(init.headers).get('if-none-match'), '*');
      if (item) return new Response('', { status: 412 });
      const stored = { body: String(init.body), version: `synthetic-storage-${++revision}` };
      storageObjects.set(key, stored); writes++;
      return new Response('', { headers: { 'x-amz-version-id': stored.version, 'x-amz-server-side-encryption': 'AES256' } });
    };
    const binding = { authenticated_caller: 'cfo', run: f.config.run, room: 'finance', source_index: 'finance-cfo-source-docs' };
    const config = { schema: 'identity-registry-production-v1', registry_id: f.config.registryId,
      authority: f.config.authority, binding, public_key: f.config.publicKey,
      partition_manifest_version: f.partitionManifestVersion,
      source: { prefix: 'graph-trial/source-authority', manifest: f.config.manifest, pointer: f.config.pointer, catalog: f.catalog },
      storage: { prefix, approved_policy_canonical_sha256: policyHash, approved_storage_scope_sha256: scopeHash, sse: { algorithm: 'AES256' } } };
    const resolver = createProductionIdentityRegistryResolver(JSON.stringify(config));
    const options = { signal: new AbortController().signal };
    assert.equal(await resolver.resolve({ registry_id: config.registry_id, caller: { ...context, caller_agent: 'clo' } }, options), null);
    const resolved = await resolver.resolve({ registry_id: config.registry_id, caller: context }, options);
    assert.ok(resolved);
    const active = { status: 'active', run: binding.run, superseded_run: null, tombstone: null };
    const app = Fastify({ logger: false });
    registerGraphWorkerBrokerRoutes(app, {
      identityRegistry: resolver, authenticate: async () => context,
      bindingsJson: () => JSON.stringify({ schema: 'graph-worker-bindings-v1', policy_version: 'synthetic-production', expires_at: '2030-01-01T00:00:00.000Z', bindings: [binding] }),
      now: () => Date.now(), resolveCohortBinding: async () => null,
      readCfoText: async () => { throw Error('no_document_text_reads'); },
      s3: async request => {
        assert.equal(request.key, helper.statePrefix(binding) + '/active-runs/' + helper.bindingHash(binding.run) + '.json');
        return { status: 200, headers: new Headers({ etag: '"synthetic-active-state"' }), body: Buffer.from(canonicalJson({ schema: 'neptune-trial-active-run-state-v1', state_sha256: hash(active), state: active })) };
      },
    });
    try {
      const base = `/graph-worker/v1/identity-registry/${config.registry_id}`;
      const authorization = await app.inject({ method: 'POST', url: base + '/authorize', headers: { authorization: 'Bearer synthetic-only' }, payload: {
        schema: 'source-identity-registry-authorization-v1', action: 'read_page', authenticated_caller: 'cfo',
        authority: config.authority, cursor: null, source_version: null,
      } });
      assert.equal(authorization.statusCode, 200, authorization.body);
      const { decision_ref, policy_version } = authorization.json();
      const requestPage = () => app.inject({ method: 'POST', url: base + '/page', headers: { authorization: 'Bearer synthetic-only' }, payload: {
        authority: config.authority, cursor: null, source_version: null, page_size: 100, authorization: { decision_ref, policy_version },
      } });
      const page = await requestPage();
      assert.equal(page.statusCode, mode === 'valid' ? 200 : 503, page.body);
      if (mode === 'valid') {
        assert.equal(page.json().records[0].endpoint.identifier.value, 'entity-1');
        const publication = { registry_id: config.registry_id, version: 'synthetic-snapshot-v1', envelope: { synthetic_only: true } };
        assert.equal(await resolved.snapshots.publish(publication, options), true);
        const replica = await createProductionIdentityRegistryResolver(JSON.stringify(config)).resolve({ registry_id: config.registry_id, caller: context }, options);
        assert.deepEqual(await replica.snapshots.read(publication, options), { status: 'active', envelope: publication.envelope });
        assert.ok(pinnedReads > 0); assert.ok(writes >= 2);
        policyChanged = true;
        await assert.rejects(replica.snapshots.read(publication, options), /identity_registry_s3_policy_mismatch/);
        policyChanged = false;
        f.setPointer(f.sign({ ...f.pointer.snapshot, revoked: true }));
        assert.equal((await requestPage()).statusCode, 503);
      }
    } finally { await app.close(); }
  }
  process.stdout.write(JSON.stringify({ synthetic_only: true, real_aws_calls: realCalls,
    normal_configured_factory: true, production_sigv4: true, source_page_route: true,
    malformed_source_records_denied: true, revoked_source_denied: true,
    recreated_replica_pinned_read: true, changed_policy_denied: true }) + '\n');
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
