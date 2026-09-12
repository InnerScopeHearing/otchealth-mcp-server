import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { GraphWorkerBrokerDeps } from './graph-worker-broker.js';
import { publicErrorResponse } from './public-error-response.js';

const SYNTHETIC_REQUIRED_ENV = Object.freeze({
  CIO_SITE_ID: 'synthetic',
  CIO_TRACK_KEY: 'synthetic',
  CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'synthetic-placeholder-value-000000000',
  ADMIN_REVOKE_TOKEN: 'synthetic-placeholder-value-000000000',
  N8N_WEBHOOK_SECRET: 'synthetic-placeholder-value-000000000',
});
for (const [name, value] of Object.entries(SYNTHETIC_REQUIRED_ENV)) {
  process.env[name] ??= value;
}
const {
  graphWorkerBrokerTest: helper,
  registerGraphWorkerBrokerRoutes,
} = await import('./graph-worker-broker.js');

const NOW = Date.parse('2026-09-08T04:00:00.000Z');
const H = (value: string) => helper.digest(value);
const projectionSha = (row: Record<string, unknown>) => {
  const pinned: Record<string, unknown> = {
    path: row.path, sha256: row.sha256, sidecar: row.sidecar,
    enriched: row.enriched, enriched_sha256: row.enriched_sha256,
    err: row.err ?? null, doc_date: row.doc_date ?? null,
  };
  for (const field of ['entity','entities','named_entities_orgs',
    'named_entities_people','signatories','counterparty']) {
    pinned[field] = row[field] ?? null;
  }
  return H(helper.canonical(pinned));
};
function fixture(scope: 'finance' | 'legal_company' = 'finance') {
  const legal = scope === 'legal_company';
  const room = legal ? 'legal_company' : 'finance';
  const sourceIndex = legal ? 'legal-company' : 'finance-cfo-source-docs';
  const caller = legal ? 'clo' : 'cfo';
  const row = {
    path: legal ? 'company/synthetic-contract.txt' : 'finance/report.txt', sha256: H('source bytes'), sidecar: true,
    enriched: true, enriched_sha256: H('source bytes'), err: null,
    doc_date: '2026-09-01', entity: 'Synthetic Co', entities: ['Synthetic Co'],
    named_entities_orgs: ['Synthetic Co'], named_entities_people: [],
    signatories: [], counterparty: null,
  };
  const sourceVersion = row.sha256;
  const sourcePathHash = H(row.path);
  const authority = {
    source_room: room, source_index: sourceIndex,
    policy_ref: 'gateway:isLaneAllowed',
  };
  const documentVersionId = 'docv_' + H('graph-assertion-v2\0' + helper.canonical({
    authority, source_path_hash: sourcePathHash, source_version: sourceVersion,
  }));
  const item = {
    ordinal: 0, room, document_version_id: documentVersionId,
    source_version: sourceVersion, source_path_hash: sourcePathHash,
    enrichment_row_sha256: projectionSha(row),
    extractor_version: 'catalog-mention-snapshot-v1', retract_event_ids: [],
  };
  const manifestContent = {
    version: 'graph-backfill-runner-v1',
    created_at: '2026-09-08T03:59:00.000Z', documents: [item],
  };
  const manifest = {
    ...manifestContent, manifest_sha256: H(helper.canonical(manifestContent)),
  };
  const runContent = {
    ref_version: 'neptune-trial-active-run-ref-v1',
    purpose: 'company_graph_backfill', scope,
    run_version: 'pilot-v1', manifest_sha256: manifest.manifest_sha256,
  };
  const run = { ...runContent, run_id: 'run_' + H(helper.canonical(runContent)) };
  const binding = {
    authenticated_caller: caller, run, room, source_index: sourceIndex,
  };
  const policy = {
    schema: 'graph-worker-bindings-v1', policy_version: 'gateway-policy-v1',
    expires_at: '2026-09-08T04:10:00.000Z', bindings: [binding],
  };
  const activeState = {
    status: 'active', run, superseded_run: null, tombstone: null,
  };
  const active = {
    schema: 'neptune-trial-active-run-state-v1',
    state_sha256: H(helper.canonical(activeState)), state: activeState,
  };
  const sourceId = helper.sourceId(binding, item);
  const sourceEnvelope = {
    schema: 'catalog-mention-snapshot-v1', room,
    document_version_id: documentVersionId, row,
  };
  const inputSha = helper.metadataInputSha(row, item, room);
  return {
    row, item, manifest, run, binding, policy, active, sourceId,
    sourceEnvelope, inputSha,
  };
}
function headers(etag = '"e1"') {
  return new Headers({ etag, 'content-type': 'application/json' });
}
async function harness(options: {
  caller?: string; scope?: 'finance' | 'legal_company'; policy?: unknown; active?: unknown; row?: unknown; transportError?: boolean;
  readCfoText?: GraphWorkerBrokerDeps['readCfoText'];
  readCompanyText?: GraphWorkerBrokerDeps['readCompanyText'];
  resolveCohortBinding?: GraphWorkerBrokerDeps['resolveCohortBinding'];
  identityRegistry?: GraphWorkerBrokerDeps['identityRegistry'];
  now?: () => number;
  rateLimit?: boolean;
} = {}) {
  const f = fixture(options.scope);
  let revision = 1;
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const put = (key: string, value: unknown, etag = '"e1"') =>
    objects.set(key, { body: Buffer.from(helper.canonical(value)), etag });
  put(helper.statePrefix(f.binding) + '/active-runs/' +
    helper.bindingHash(f.run) + '.json', options.active ?? f.active);
  put(helper.sourcePrefix(f.binding) + '/manifests/' + f.manifest.manifest_sha256 + '.json',
    f.manifest);
  put(helper.sourcePrefix(f.binding) + '/rows/' + f.item.room + '/' + f.item.enrichment_row_sha256 + '.json',
    options.row ?? f.sourceEnvelope);
  const s3: GraphWorkerBrokerDeps['s3'] = async (request) => {
    if (options.transportError) throw new Error('sensitive upstream text');
    const current = objects.get(request.key);
    if (request.method === 'GET') {
      return current
        ? { status: 200, headers: headers(current.etag), body: current.body }
        : { status: 404, headers: headers(), body: Buffer.alloc(0) };
    }
    if (request.headers?.['if-none-match'] === '*' && current) {
      return { status: 412, headers: headers(), body: Buffer.from('<private/>') };
    }
    if (request.headers?.['if-match'] &&
        request.headers['if-match'] !== current?.etag) {
      return { status: 412, headers: headers(), body: Buffer.from('<private/>') };
    }
    const etag = '"e' + (++revision) + '"';
    objects.set(request.key, { body: request.body!, etag });
    return { status: 201, headers: headers(etag), body: Buffer.alloc(0) };
  };
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as typeof request & { rawBody?: string }).rawBody = body as string;
    try { done(null, JSON.parse(body as string)); } catch (error) { done(error as Error); }
  });
  if (options.rateLimit) {
    await app.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
    app.setErrorHandler(async (error, _request, reply) => {
      const response = publicErrorResponse(error);
      await reply.code(response.statusCode).send(response.body);
    });
  }
  registerGraphWorkerBrokerRoutes(app, {
    authenticate: async (request) => ({
      caller_hash: H('caller'), raw_token: 'test-only',
      caller_agent: options.caller ??
        (request.headers.authorization === 'Bearer cto' ? 'cto' :
          request.headers.authorization === 'Bearer clo' ? 'clo' :
            request.headers.authorization === 'Bearer cfo' ? 'cfo' : f.binding.authenticated_caller),
      connector_surface: true, m365_static_auth: false,
    }),
    bindingsJson: () => JSON.stringify(options.policy ?? f.policy),
    now: options.now ?? (() => NOW),
    s3,
    resolveCohortBinding: options.resolveCohortBinding,
    identityRegistry: options.identityRegistry,
    readCfoText: options.readCfoText ?? (async (source) => Object.freeze({
      outcome: 'missing_text' as const,
      source_document_version: source.document_version_id,
      catalog_source_sha256: source.source_version,
      source_path_hash: source.source_path_hash,
      observed_bytes: null,
      chunks: Object.freeze([]),
    })),
    readCompanyText: options.readCompanyText ?? (async (source) => Object.freeze({
      outcome: 'missing_text' as const,
      source_document_version: source.document_version_id,
      catalog_source_sha256: source.source_version,
      source_path_hash: source.source_path_hash,
      observed_bytes: null,
      chunks: Object.freeze([]),
    })),
  });
  await app.ready();
  return { app, f, objects };
}
const authHeaders = { authorization: 'Bearer cfo', 'content-type': 'application/json' };

test('identity registry readiness is CFO-only, metadata-only, and does not claim coverage without a checked binding', async () => {
  const missing = await harness();
  const missingResponse = await missing.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: missing.f.run.run_id } });
  assert.equal(missingResponse.statusCode, 200);
  assert.deepEqual(missingResponse.json(), { configured: false, valid_config: false, storage_policy_ready: false, coverage_ready: false, reason: 'not_configured' });
  await missing.app.close();

  const unavailable = await harness({ identityRegistry: { resolve: async () => { throw new Error('synthetic storage failure'); } } });
  const unavailableResponse = await unavailable.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: unavailable.f.run.run_id } });
  assert.equal(unavailableResponse.statusCode, 200);
  assert.deepEqual(unavailableResponse.json(), { configured: null, valid_config: null, storage_policy_ready: null, coverage_ready: false, reason: 'resolver_unavailable' });
  assert.equal(unavailableResponse.body.includes('synthetic storage failure'), false);
  await unavailable.app.close();

  const absent = await harness({ identityRegistry: { resolve: async () => null } });
  const absentResponse = await absent.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: absent.f.run.run_id } });
  assert.deepEqual(absentResponse.json(), { configured: false, valid_config: null, storage_policy_ready: null, coverage_ready: false, reason: 'registry_not_configured' });
  await absent.app.close();

  const invalid = await harness({ identityRegistry: { resolve: async () => ({ registry_id: 'ready-registry' } as any) } });
  const invalidResponse = await invalid.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: invalid.f.run.run_id } });
  assert.deepEqual(invalidResponse.json(), { configured: true, valid_config: false, storage_policy_ready: null, coverage_ready: false, reason: 'invalid_config' });
  await invalid.app.close();

  const keyPair = generateKeyPairSync('ed25519');
  const key = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const authority = { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'synthetic', source_system: 'synthetic', scope: 'cfo' as const, version: 'v1' };
  const coverageHash = H('catalog-coverage');
  const shards = '0123456789abcdef'.split('').map(prefix => ({
    shard_id: 'shard-' + prefix, partition_prefix: prefix, registry_version: 'sirv_' + prefix,
    source_version: 'source-' + prefix, snapshot_sha256: H('snapshot-' + prefix),
    binding_set_sha256: H('bindings-' + prefix), binding_count: 0,
  }));
  const coverage = { schema: 'source-identity-catalog-coverage-v1', catalog_version: 'catalog-v1', complete: true,
    coverage_sha256: coverageHash, expected_shard_count: shards.length, source_binding_count: 0,
    source_binding_set_sha256: H('binding-set') };
  const unsigned = { schema: 'source-identity-registry-partition-manifest-v1', registry_id: 'ready-registry',
    source_authority: authority, source_generation: 'generation-1', catalog_coverage: coverage,
    shards, public_key_sha256: createHash('sha256').update(keyPair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  const manifestVersion = 'sirm_' + H(helper.canonical(unsigned));
  const snapshot = { ...unsigned, version: manifestVersion };
  const envelope = { snapshot, signature: sign(null, Buffer.from(helper.canonical(snapshot)), keyPair.privateKey).toString('base64') };
  const registry = (covered: boolean): GraphWorkerBrokerDeps['identityRegistry'] => ({ resolve: async ({ registry_id }) => registry_id === 'ready-registry' ? ({
    registry_id, authority, binding: fixture().binding, public_key: key, storage_policy_ready: true,
    source: { page: async () => ({ }), current: async () => true },
    snapshots: { publish: async () => true, read: async () => ({ status: 'missing' as const }) },
    partitions: { manifest_version: manifestVersion, read_manifest: async () => ({ status: 'active' as const, envelope }),
      manifest_current: async () => true, binding_covered: async () => covered },
  } as any) : null });
  const ready = await harness({ identityRegistry: registry(true) });
  const response = await ready.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: ready.f.run.run_id } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { configured: true, valid_config: true, storage_policy_ready: true, coverage_ready: false, reason: 'coverage_not_checked' });
  const covered = await ready.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: ready.f.run.run_id, source_binding_sha256: H('binding') } });
  assert.deepEqual(covered.json(), { configured: true, valid_config: true, storage_policy_ready: true, coverage_ready: true, reason: 'coverage_checked' });
  const notCovered = await harness({ identityRegistry: registry(false) });
  const missingCoverage = await notCovered.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: notCovered.f.run.run_id, source_binding_sha256: H('binding') } });
  assert.deepEqual(missingCoverage.json(), { configured: true, valid_config: true, storage_policy_ready: true, coverage_ready: false, reason: 'coverage_missing' });
  await notCovered.app.close();
  const wrongRun = await ready.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: authHeaders, payload: { run_id: 'run_' + 'a'.repeat(64) } });
  assert.equal(wrongRun.statusCode, 200);
  assert.equal(wrongRun.json().reason, 'run_mismatch');
  const denied = await ready.app.inject({ method: 'POST', url: '/graph-worker/v1/identity-registry/ready-registry/readiness',
    headers: { ...authHeaders, authorization: 'Bearer cto' }, payload: { run_id: ready.f.run.run_id } });
  assert.equal(denied.statusCode, 403);
  await ready.app.close();
});

function authorizeRequest(f: ReturnType<typeof fixture>) {
  return {
    schema: 'company-metadata-gateway-authorization-v1',
    phase: 'model_source_access', authenticated_caller: 'cfo', run: f.run,
    source: {
      source_id: f.sourceId,
      subscription_source_version: f.item.document_version_id,
      room: 'finance', source_index: 'finance-cfo-source-docs',
      manifest_sha256: f.manifest.manifest_sha256, document_ordinal: 0,
      document_version_id: f.item.document_version_id,
      source_version: f.item.source_version,
      purpose: f.run.purpose, canonical_input_sha256: f.inputSha,
    },
  };
}

test('broker dependency aborts and stream cancellation stay bounded', async () => {
  const controller = new AbortController();
  const pending = helper.abortable(new Promise<never>(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, /deadline/);

  const started = Date.now();
  let cancels = 0;
  await helper.boundedCancel({
    cancel: () => { cancels++; return new Promise<void>(() => {}); },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>);
  assert.equal(cancels, 1);
  assert.ok(Date.now() - started < 500);
});

test('control and authorization bind exact authenticated CFO run and reject CTO/query auth', async () => {
  const h = await harness();
  const control = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/control',
    headers: authHeaders, payload: { run: h.f.run, action: 'subscription_worker' },
  });
  assert.equal(control.statusCode, 200);
  assert.deepEqual(control.json().active, { allowed: true, active_run_id: h.f.run.run_id });

  const authorized = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/authorize',
    headers: authHeaders, payload: authorizeRequest(h.f),
  });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(authorized.json().provenance.allowed_roles, ['cfo']);

  const cto = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/control',
    headers: { ...authHeaders, authorization: 'Bearer cto' },
    payload: { run: h.f.run, action: 'subscription_worker' },
  });
  assert.equal(cto.statusCode, 403);
  const query = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/control?token=ignored',
    headers: authHeaders, payload: { run: h.f.run, action: 'subscription_worker' },
  });
  assert.equal(query.statusCode, 401);
  await h.app.close();
});

test('dynamic cohort recheck uses the fresh cohort resolver without a static policy match', async () => {
  const expected = fixture();
  const h = await harness({
    policy: 'not-json',
    resolveCohortBinding: async () => ({ policy: expected.policy, binding: expected.binding }),
  });
  const response = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/authorize', headers: authHeaders,
    payload: authorizeRequest(h.f),
  });
  assert.equal(response.statusCode, 200);
  await h.app.close();
});

test('expired policy, retired active pointer, and transport errors fail closed with safe errors', async () => {
  const expired = fixture();
  const a = await harness({ policy: { ...expired.policy, expires_at: '2026-09-08T03:59:59.000Z' } });
  const aResult = await a.app.inject({
    method: 'POST', url: '/graph-worker/v1/control', headers: authHeaders,
    payload: { run: a.f.run, action: 'subscription_worker' },
  });
  assert.equal(aResult.statusCode, 503);
  await a.app.close();

  const retired = fixture();
  const state = { status: 'retired', run: retired.run, superseded_run: null, tombstone: retired.run };
  const b = await harness({ active: {
    schema: 'neptune-trial-active-run-state-v1',
    state_sha256: H(helper.canonical(state)), state,
  } });
  const bResult = await b.app.inject({
    method: 'POST', url: '/graph-worker/v1/control', headers: authHeaders,
    payload: { run: b.f.run, action: 'subscription_worker' },
  });
  assert.equal(bResult.statusCode, 503);
  await b.app.close();

  const c = await harness({ transportError: true });
  const cResult = await c.app.inject({
    method: 'POST', url: '/graph-worker/v1/control', headers: authHeaders,
    payload: { run: c.f.run, action: 'subscription_worker' },
  });
  assert.equal(cResult.statusCode, 503);
  assert.equal(cResult.body.includes('sensitive upstream text'), false);
  await c.app.close();
});

test('CLO company-text currentness uses only the legal-company tuple and never returns text', async () => {
  const expected = fixture('legal_company');
  const text = 'Synthetic corporate legal source excerpt.';
  let calls = 0;
  const h = await harness({
    scope: 'legal_company',
    readCompanyText: async (source, callerContext, signal) => {
      calls++;
      assert.equal(signal.aborted, false);
      assert.equal(callerContext.caller_agent, 'clo');
      assert.deepEqual(source, {
        room: 'legal_company', source_index: 'legal-company',
        path: 'company/synthetic-contract.txt',
        source_path_hash: expected.item.source_path_hash,
        document_version_id: expected.item.document_version_id,
        source_version: expected.item.source_version,
      });
      return Object.freeze({
        outcome: 'ready' as const,
        descriptor: Object.freeze({
          schema: 'company-version-pinned-text-snapshot-v1' as const,
          room: 'legal_company' as const, source_index: 'legal-company' as const,
          source_document_version: source.document_version_id,
          catalog_source_sha256: source.source_version,
          source_lineage_status: 'catalog_association_only' as const,
          source_path_hash: source.source_path_hash,
          sidecar_path_hash: H('_TEXT/' + source.path + '.txt'),
          sidecar_etag: '"synthetic-etag"', sidecar_version_id: 'synthetic-version',
          sidecar_content_sha256: H(text), total_bytes: Buffer.byteLength(text),
          total_chars_utf16: text.length, chunk_count: 1, chunk_overlap_chars: 200,
        }),
        chunks: Object.freeze([Object.freeze({
          ordinal: 0, start_utf16: 0, end_utf16: text.length,
          start_byte: 0, end_byte: Buffer.byteLength(text), text_sha256: H(text), text,
        })]),
      });
    },
  });
  const url = '/graph-worker/v1/source/' + h.f.run.run_id + '/company-text-currentness';
  const response = await h.app.inject({
    method: 'POST', url, headers: { authorization: 'Bearer clo', 'content-type': 'application/json' },
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), {
    schema: 'company-text-currentness-v1', run_id: h.f.run.run_id, document_ordinal: 0,
    outcome: 'ready', source_document_version: expected.item.document_version_id,
    catalog_source_sha256: expected.item.source_version, sidecar_content_sha256: H(text),
  });
  assert.equal(response.body.includes(text), false);
  assert.equal(response.body.includes('company/synthetic-contract.txt'), false);
  assert.equal(calls, 1);

  const denied = await h.app.inject({ method: 'POST', url,
    headers: { authorization: 'Bearer cfo', 'content-type': 'application/json' },
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls, 1);
  await h.app.close();
});

test('CLO prepared text loads the legal catalog prefix and serves the bound company chunk', async () => {
  const expected = fixture('legal_company');
  const text = 'Synthetic legal company source excerpt.';
  const h = await harness({
    scope: 'legal_company',
    readCompanyText: async (source, callerContext, signal) => {
      assert.equal(signal.aborted, false);
      assert.equal(callerContext.caller_agent, 'clo');
      assert.deepEqual(source, {
        room: 'legal_company', source_index: 'legal-company',
        path: 'company/synthetic-contract.txt',
        source_path_hash: expected.item.source_path_hash,
        document_version_id: expected.item.document_version_id,
        source_version: expected.item.source_version,
      });
      return Object.freeze({
        outcome: 'ready' as const,
        descriptor: Object.freeze({
          schema: 'company-version-pinned-text-snapshot-v1' as const,
          room: 'legal_company' as const, source_index: 'legal-company' as const,
          source_document_version: source.document_version_id,
          catalog_source_sha256: source.source_version,
          source_lineage_status: 'catalog_association_only' as const,
          source_path_hash: source.source_path_hash,
          sidecar_path_hash: H('_TEXT/' + source.path + '.txt'),
          sidecar_etag: '"synthetic-etag"', sidecar_version_id: 'synthetic-version',
          sidecar_content_sha256: H(text), total_bytes: Buffer.byteLength(text),
          total_chars_utf16: text.length, chunk_count: 1, chunk_overlap_chars: 200,
        }),
        chunks: Object.freeze([Object.freeze({
          ordinal: 0, start_utf16: 0, end_utf16: text.length,
          start_byte: 0, end_byte: Buffer.byteLength(text), text_sha256: H(text), text,
        })]),
      });
    },
  });
  assert.ok(h.objects.has(helper.COMPANY_SOURCE_PREFIX + '/manifests/' + h.f.manifest.manifest_sha256 + '.json'));
  assert.ok(h.objects.has(helper.COMPANY_SOURCE_PREFIX + '/rows/legal_company/' + h.f.item.enrichment_row_sha256 + '.json'));
  const url = '/graph-worker/v1/source/' + h.f.run.run_id + '/company-text-snapshots';
  const receipt = await h.app.inject({
    method: 'POST', url,
    headers: { authorization: 'Bearer clo', 'content-type': 'application/json' },
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(receipt.statusCode, 200);
  assert.equal(receipt.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(receipt.json()).sort(), [
    'chunk_count', 'document_ordinal', 'manifest_sha256', 'observed_bytes', 'outcome',
    'paid_fallback', 'run_id', 'schema', 'sidecar_content_sha256', 'snapshot_id',
    'source_document_version',
  ]);
  assert.equal(receipt.json().schema, 'company-text-preparation-v1');
  assert.equal(receipt.json().outcome, 'ready');
  const chunk = await h.app.inject({
    method: 'GET', url: url + '/' + receipt.json().snapshot_id + '/chunks/0',
    headers: { authorization: 'Bearer clo' },
  });
  assert.equal(chunk.statusCode, 200);
  assert.equal(chunk.headers['cache-control'], 'no-store');
  assert.equal(chunk.json().schema, 'company-text-prepared-chunk-v1');
  assert.equal(chunk.json().text, text);
  assert.equal(chunk.json().manifest_sha256, receipt.json().manifest_sha256);
  const denied = await h.app.inject({
    method: 'POST', url,
    headers: { authorization: 'Bearer cfo', 'content-type': 'application/json' },
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(denied.statusCode, 403);
  await h.app.close();
});

test('CFO text preparation persists bound refs and serves only an exact prepared chunk', async () => {
  const calls: unknown[] = [];
  const expected = fixture();
  const text = 'Synthetic CFO source excerpt.';
  const h = await harness({
    readCfoText: async (source, callerContext, signal) => {
      assert.equal(signal.aborted, false);
      assert.equal(callerContext.caller_agent, 'cfo');
      assert.ok(Object.isFrozen(source));
      assert.deepEqual(source, {
        room: 'finance', source_index: 'finance-cfo-source-docs',
        path: 'finance/report.txt',
        source_path_hash: expected.item.source_path_hash,
        document_version_id: expected.item.document_version_id,
        source_version: expected.item.source_version,
      });
      calls.push(source);
      return Object.freeze({
        outcome: 'ready' as const,
        descriptor: Object.freeze({
          schema: 'cfo-version-pinned-text-snapshot-v1' as const,
          room: 'finance' as const,
          source_index: 'finance-cfo-source-docs' as const,
          source_document_version: source.document_version_id,
          catalog_source_sha256: source.source_version,
          source_lineage_status: 'catalog_association_only' as const,
          source_path_hash: source.source_path_hash,
          sidecar_path_hash: H('_TEXT/' + source.path + '.txt'),
          sidecar_etag: '"synthetic-etag"',
          sidecar_version_id: 'synthetic-version',
          sidecar_content_sha256: H(text),
          total_bytes: Buffer.byteLength(text),
          total_chars_utf16: text.length,
          chunk_count: 1,
          chunk_overlap_chars: 200,
        }),
        chunks: Object.freeze([Object.freeze({
          ordinal: 0, start_utf16: 0, end_utf16: text.length,
          start_byte: 0, end_byte: Buffer.byteLength(text),
          text_sha256: H(text), text,
        })]),
      });
    },
  });
  const url = '/graph-worker/v1/source/' + h.f.run.run_id + '/cfo-text-snapshots';
  const response = await h.app.inject({
    method: 'POST', url, headers: authHeaders,
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const receipt = response.json();
  assert.equal(receipt.outcome, 'ready');
  assert.match(receipt.snapshot_id, /^txtsnap_[a-f0-9]{64}$/);
  assert.match(receipt.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.sidecar_content_sha256, H(text));
  assert.equal(calls.length, 1);

  const chunk = await h.app.inject({
    method: 'GET',
    url: url + '/' + receipt.snapshot_id + '/chunks/0',
    headers: { authorization: 'Bearer cfo' },
  });
  assert.equal(chunk.statusCode, 200);
  assert.equal(chunk.headers['cache-control'], 'no-store');
  assert.equal(chunk.json().text, text);
  assert.equal(chunk.json().manifest_sha256, receipt.manifest_sha256);
  assert.equal(chunk.json().sidecar_content_sha256, receipt.sidecar_content_sha256);
  assert.equal(chunk.json().source_document_version, receipt.source_document_version);

  const later = await h.app.inject({
    method: 'POST', url, headers: authHeaders,
    payload: { run: h.f.run, document_ordinal: 1 },
  });
  assert.equal(later.statusCode, 400);
  const cto = await h.app.inject({
    method: 'POST', url, headers: { ...authHeaders, authorization: 'Bearer cto' },
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(cto.statusCode, 403);
  assert.equal(calls.length, 1);
  await h.app.close();
});

test('CFO prepared binding page validates the target run and never returns prepared text', async () => {
  const expected = fixture();
  const text = 'Synthetic target-run source excerpt.';
  const h = await harness({
    readCfoText: async (source) => Object.freeze({
      outcome: 'ready' as const,
      descriptor: Object.freeze({
        schema: 'cfo-version-pinned-text-snapshot-v1' as const,
        room: 'finance' as const,
        source_index: 'finance-cfo-source-docs' as const,
        source_document_version: source.document_version_id,
        catalog_source_sha256: source.source_version,
        source_lineage_status: 'catalog_association_only' as const,
        source_path_hash: source.source_path_hash,
        sidecar_path_hash: H('_TEXT/' + source.path + '.txt'),
        sidecar_etag: '"synthetic-etag"', sidecar_version_id: 'synthetic-version',
        sidecar_content_sha256: H(text), total_bytes: Buffer.byteLength(text),
        total_chars_utf16: text.length, chunk_count: 1, chunk_overlap_chars: 200,
      }),
      chunks: Object.freeze([Object.freeze({
        ordinal: 0, start_utf16: 0, end_utf16: text.length,
        start_byte: 0, end_byte: Buffer.byteLength(text), text_sha256: H(text), text,
      })]),
    }),
  });
  const url = '/graph-worker/v1/source/' + h.f.run.run_id + '/cfo-text-bindings';
  const response = await h.app.inject({
    method: 'POST', url, headers: authHeaders,
    payload: { run: h.f.run, document_ordinal: 0 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const page = response.json();
  assert.deepEqual(Object.keys(page).sort(), ['bindings', 'run_id', 'schema']);
  assert.equal(page.schema, 'cfo-prepared-binding-page-v1');
  assert.equal(page.run_id, h.f.run.run_id);
  assert.equal(page.bindings.length, 1);
  assert.deepEqual(page.bindings[0], {
    schema: 'cfo-prepared-chunk-binding-v1', run_id: h.f.run.run_id, room: 'finance',
    source_index: 'finance-cfo-source-docs', catalog_manifest_sha256: h.f.run.manifest_sha256,
    document_ordinal: 0, source_document_version: expected.item.document_version_id,
    catalog_source_sha256: expected.item.source_version,
    snapshot_id: page.bindings[0].snapshot_id,
    prepared_manifest_sha256: page.bindings[0].prepared_manifest_sha256,
    sidecar_content_sha256: H(text), chunk_ordinal: 0, chunk_sha256: H(text),
  });
  assert.equal(JSON.stringify(page).includes(text), false);

  const wrongRun = { ...h.f.run, run_id: 'run_' + H('wrong') };
  const forbidden = await h.app.inject({ method: 'POST', url, headers: authHeaders,
    payload: { run: wrongRun, document_ordinal: 0 } });
  assert.equal(forbidden.statusCode, 400);
  const cto = await h.app.inject({ method: 'POST', url, headers: { ...authHeaders, authorization: 'Bearer cto' },
    payload: { run: h.f.run, document_ordinal: 0 } });
  assert.equal(cto.statusCode, 403);
  await h.app.close();
});

test('CFO prepared binding page reconstructs a bounded 100-chunk target snapshot without rereading the source', async () => {
  const chunks = Array.from({ length: 100 }, (_, ordinal) => {
    const text = `synthetic-${ordinal.toString().padStart(3, '0')}`;
    const start = ordinal * text.length;
    return Object.freeze({ ordinal, start_utf16: start, end_utf16: start + text.length,
      start_byte: start, end_byte: start + Buffer.byteLength(text), text_sha256: H(text), text });
  });
  const sourceText = chunks.map(chunk => chunk.text).join('');
  let reads = 0;
  const h = await harness({
    readCfoText: async (source, _caller, signal) => {
      reads++;
      assert.equal(signal.aborted, false);
      return Object.freeze({ outcome: 'ready' as const, descriptor: Object.freeze({
        schema: 'cfo-version-pinned-text-snapshot-v1' as const, room: 'finance' as const,
        source_index: 'finance-cfo-source-docs' as const,
        source_document_version: source.document_version_id, catalog_source_sha256: source.source_version,
        source_lineage_status: 'catalog_association_only' as const, source_path_hash: source.source_path_hash,
        sidecar_path_hash: H('_TEXT/' + source.path + '.txt'), sidecar_etag: '"synthetic-etag"',
        sidecar_version_id: 'synthetic-version', sidecar_content_sha256: H(sourceText),
        total_bytes: Buffer.byteLength(sourceText), total_chars_utf16: sourceText.length,
        chunk_count: chunks.length, chunk_overlap_chars: 200,
      }), chunks });
    },
  });
  const response = await h.app.inject({ method: 'POST',
    url: '/graph-worker/v1/source/' + h.f.run.run_id + '/cfo-text-bindings', headers: authHeaders,
    payload: { run: h.f.run, document_ordinal: 0 } });
  assert.equal(response.statusCode, 200);
  const page = response.json();
  assert.equal(page.bindings.length, 100);
  assert.equal(page.bindings[0].chunk_sha256, chunks[0].text_sha256);
  assert.equal(page.bindings[99].chunk_sha256, chunks[99].text_sha256);
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(page).includes(chunks[50].text), false);
  await h.app.close();
});

test('CFO text preparation permits a bounded review batch and reports rate limiting safely', async () => {
  const h = await harness({ rateLimit: true });
  const url = '/graph-worker/v1/source/' + h.f.run.run_id + '/cfo-text-snapshots';
  const request = () => h.app.inject({
    method: 'POST', url, headers: authHeaders,
    payload: { run: h.f.run, document_ordinal: 0 },
  });

  for (let count = 0; count < 30; count++) {
    const response = await request();
    assert.equal(response.statusCode, 200);
  }

  const limited = await request();
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), {
    error: 'rate_limited', message: 'Too many requests. Retry later.',
  });
  assert.equal(limited.headers['x-ratelimit-limit'], '30');
  assert.equal(limited.headers['x-ratelimit-remaining'], '0');
  assert.match(limited.headers['x-ratelimit-reset'] ?? '', /^\d+$/);
  assert.match(limited.headers['retry-after'] ?? '', /^\d+$/);
  await h.app.close();
});

test('prepared operations bind actual snapshot chunks, isolate snapshots, and fail closed when stale', async () => {
  let sourceRead = 0;
  let now = NOW;
  const text = 'Synthetic prepared CFO chunk.';
  const h = await harness({
    now: () => now,
    readCfoText: async (source) => {
      const version = ++sourceRead;
      return Object.freeze({
        outcome: 'ready' as const,
        descriptor: Object.freeze({
          schema: 'cfo-version-pinned-text-snapshot-v1' as const,
          room: 'finance' as const,
          source_index: 'finance-cfo-source-docs' as const,
          source_document_version: source.document_version_id,
          catalog_source_sha256: source.source_version,
          source_lineage_status: 'catalog_association_only' as const,
          source_path_hash: source.source_path_hash,
          sidecar_path_hash: H('_TEXT/' + source.path + '.txt'),
          sidecar_etag: '"synthetic-etag-' + version + '"',
          sidecar_version_id: 'synthetic-version-' + version,
          sidecar_content_sha256: H(text),
          total_bytes: Buffer.byteLength(text),
          total_chars_utf16: text.length,
          chunk_count: 1,
          chunk_overlap_chars: 200,
        }),
        chunks: Object.freeze([Object.freeze({
          ordinal: 0, start_utf16: 0, end_utf16: text.length,
          start_byte: 0, end_byte: Buffer.byteLength(text),
          text_sha256: H(text), text,
        })]),
      });
    },
  });
  const prepareUrl = '/graph-worker/v1/source/' + h.f.run.run_id + '/cfo-text-snapshots';
  const prepare = async () => {
    const response = await h.app.inject({
      method: 'POST', url: prepareUrl, headers: authHeaders,
      payload: { run: h.f.run, document_ordinal: 0 },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().outcome, 'ready');
    return response.json();
  };
  const firstReceipt = await prepare();
  const secondReceipt = await prepare();
  assert.notEqual(firstReceipt.snapshot_id, secondReceipt.snapshot_id);
  assert.equal(firstReceipt.sidecar_content_sha256, secondReceipt.sidecar_content_sha256);

  const prepared = (receipt: Record<string, unknown>) => {
    const sourceBinding = {
      schema: 'cfo-prepared-chunk-binding-v1',
      run_id: h.f.run.run_id,
      room: 'finance',
      source_index: 'finance-cfo-source-docs',
      catalog_manifest_sha256: h.f.run.manifest_sha256,
      document_ordinal: 0,
      source_document_version: h.f.item.document_version_id,
      catalog_source_sha256: h.f.item.source_version,
      snapshot_id: receipt.snapshot_id,
      prepared_manifest_sha256: receipt.manifest_sha256,
      sidecar_content_sha256: receipt.sidecar_content_sha256,
      chunk_ordinal: 0,
      chunk_sha256: H(text),
    };
    const sourceVersion = 'txtchunk_' + H(helper.canonical(sourceBinding));
    const sourceId = 'cfotext_' + H(helper.canonical({
      schema: 'cfo-prepared-chunk-source-v1',
      purpose: h.f.run.purpose,
      source_binding: sourceBinding,
    }));
    const document = { text, document_version_id: sourceVersion, room: 'finance' };
    const request = {
      schema: 'company-prepared-text-gateway-authorization-v1',
      phase: 'model_source_access',
      authenticated_caller: 'cfo',
      run: h.f.run,
      source: {
        source_id: sourceId,
        subscription_source_version: sourceVersion,
        purpose: h.f.run.purpose,
        canonical_input_sha256: H(helper.canonical(document)),
        source_binding: sourceBinding,
      },
    };
    return { sourceBinding, sourceVersion, sourceId, document, request };
  };
  const first = prepared(firstReceipt);
  const second = prepared(secondReceipt);
  assert.notEqual(first.sourceId, second.sourceId);
  assert.notEqual(first.sourceVersion, second.sourceVersion);

  const authorize = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/authorize',
    headers: authHeaders, payload: first.request,
  });
  assert.equal(authorize.statusCode, 200);
  const decision = authorize.json();

  const tamperedBinding = {
    ...first.sourceBinding, chunk_sha256: H('tampered chunk'),
  };
  const tamperedVersion = 'txtchunk_' + H(helper.canonical(tamperedBinding));
  const tamperedId = 'cfotext_' + H(helper.canonical({
    schema: 'cfo-prepared-chunk-source-v1',
    purpose: h.f.run.purpose,
    source_binding: tamperedBinding,
  }));
  const tamperedDocument = {
    text, document_version_id: tamperedVersion, room: 'finance',
  };
  const tamperedRequest = {
    ...first.request,
    source: {
      ...first.request.source,
      source_id: tamperedId,
      subscription_source_version: tamperedVersion,
      canonical_input_sha256: H(helper.canonical(tamperedDocument)),
      source_binding: tamperedBinding,
    },
  };
  const tamperedAuthorization = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/authorize',
    headers: authHeaders, payload: tamperedRequest,
  });
  assert.equal(tamperedAuthorization.statusCode, 403);

  const reviewRequestSha256 = H('exact synthetic review request');
  const spec = {
    authorization_ref: decision.decision_ref,
    authorization_sha256: H(helper.canonical({
      authorized: true,
      decision_ref: decision.decision_ref,
      source_binding: first.sourceBinding,
    })),
    extractor_bundle_sha256: H(helper.canonical({
      provider_source_sha256: '4e204c24fc2f70671a2a4f8896fbcd3b9e446c3917d7dd3934a783cf3a81c3f6',
      request_sha256: reviewRequestSha256,
      verifier_version: 'codex-subscription-review-provider-v1',
    })),
    extractor_version: 'codex-subscription-review-provider-v1',
    input_sha256: first.request.source.canonical_input_sha256,
    login_before_model_contract: 'codex-login-status-before-model-exec-v1',
    model: 'gpt-5.6-luna',
    provider: 'codex-chatgpt-subscription-review',
    purpose: h.f.run.purpose,
    source_id: first.sourceId,
    source_version: first.sourceVersion,
    source_binding: first.sourceBinding,
  };
  const operationId = 'subop_' + H(helper.canonical(spec));
  const operation = {
    operation_id: operationId, spec, state: 'claimed',
    claim_token: 'prepared-claim-token-1234', revision: 0,
  };
  const operationEnvelope = {
    schema: 'subscription-model-operation-v1',
    operation_id: operationId,
    operation_sha256: H(helper.canonical(operation)),
    operation,
  };
  const operationUrl = '/graph-worker/v1/state/' + h.f.run.run_id +
    '/operations/' + operationId + '.json';
  const created = await h.app.inject({
    method: 'PUT', url: operationUrl,
    headers: { ...authHeaders, 'if-none-match': '*' },
    payload: helper.canonical(operationEnvelope),
  });
  assert.equal(created.statusCode, 201);

  const secondSpec = {
    ...spec,
    source_id: second.sourceId,
    source_version: second.sourceVersion,
    source_binding: second.sourceBinding,
    input_sha256: second.request.source.canonical_input_sha256,
  };
  assert.notEqual(
    'subop_' + H(helper.canonical(secondSpec)),
    operationId,
  );

  const dispatched = {
    ...operation, state: 'dispatched', revision: 1,
    dispatched_at: '2026-09-08T04:00:01.000Z',
  };
  const dispatchedEnvelope = {
    ...operationEnvelope,
    operation_sha256: H(helper.canonical(dispatched)),
    operation: dispatched,
  };
  const updated = await h.app.inject({
    method: 'PUT', url: operationUrl,
    headers: { ...authHeaders, 'if-match': created.headers.etag as string },
    payload: helper.canonical(dispatchedEnvelope),
  });
  assert.equal(updated.statusCode, 201);

  const wrongResult = {
    operation_id: operationId,
    spec_sha256: H(helper.canonical(spec)),
    output: { source_sha256: H('wrong text') },
  };
  const wrongResultEnvelope = {
    schema: 'subscription-model-result-v1',
    operation_id: operationId,
    result_sha256: H(helper.canonical(wrongResult)),
    result: wrongResult,
  };
  const resultUrl = '/graph-worker/v1/state/' + h.f.run.run_id +
    '/results/' + operationId + '.json';
  const rejectedResult = await h.app.inject({
    method: 'PUT', url: resultUrl,
    headers: { ...authHeaders, 'if-none-match': '*' },
    payload: helper.canonical(wrongResultEnvelope),
  });
  assert.equal(rejectedResult.statusCode, 403);

  const crossRunResult = await h.app.inject({
    method: 'PUT',
    url: resultUrl.replace(h.f.run.run_id, 'run_' + H('other admitted-looking run')),
    headers: { ...authHeaders, 'if-none-match': '*' },
    payload: helper.canonical(wrongResultEnvelope),
  });
  assert.equal(crossRunResult.statusCode, 403);

  const reviewResult = {
    operation_id: operationId,
    spec_sha256: H(helper.canonical(spec)),
    output: {
      provider: 'codex-chatgpt-subscription-review', model: 'gpt-5.6-luna',
      billing_route: 'chatgpt_subscription', paid_fallback: false,
      source_sha256: H(text), candidates: [],
      review: {
        request_sha256: reviewRequestSha256, verdict: 'supported',
        subject_index: 0, object_index: 1, predicate: 'depends_on', polarity: 'positive',
        qualifications: [], evidence: { start_utf16: 0, end_utf16: text.length, quote: text },
        reason_code: 'synthetic_source_witness',
      },
    },
  };
  const reviewEnvelope = {
    schema: 'subscription-model-result-v1', operation_id: operationId,
    result_sha256: H(helper.canonical(reviewResult)), result: reviewResult,
  };
  const storedReview = await h.app.inject({
    method: 'PUT', url: resultUrl,
    headers: { ...authHeaders, 'if-none-match': '*' },
    payload: helper.canonical(reviewEnvelope),
  });
  assert.equal(storedReview.statusCode, 201);

  const complete = { ...dispatched, state: 'complete', revision: 2,
    result_sha256: reviewEnvelope.result_sha256 };
  const completeEnvelope = {
    ...dispatchedEnvelope, operation_sha256: H(helper.canonical(complete)), operation: complete,
  };
  const completed = await h.app.inject({
    method: 'PUT', url: operationUrl,
    headers: { ...authHeaders, 'if-match': updated.headers.etag as string },
    payload: helper.canonical(completeEnvelope),
  });
  assert.equal(completed.statusCode, 201);

  const bundleEntry = [...h.objects.entries()].find(([key]) =>
    key.includes('/text-snapshots/' + firstReceipt.snapshot_id + '/bundles/'));
  assert.ok(bundleEntry);
  const [bundleKey, savedBundle] = bundleEntry!;
  h.objects.set(bundleKey, {
    ...savedBundle, body: Buffer.from('{"tampered":true}'),
  });
  const corruptRead = await h.app.inject({
    method: 'GET', url: operationUrl,
    headers: { authorization: 'Bearer cfo' },
  });
  assert.equal(corruptRead.statusCode, 503);
  h.objects.set(bundleKey, savedBundle);

  now = Date.parse(h.f.policy.expires_at);
  const expiredRead = await h.app.inject({
    method: 'GET', url: operationUrl,
    headers: { authorization: 'Bearer cfo' },
  });
  assert.equal(expiredRead.statusCode, 503);
  await h.app.close();
});

test('metadata source GET refuses an unknown raw-body field outside the pinned projection', async () => {
  const f = fixture();
  const h = await harness({ row: {
    ...f.sourceEnvelope, row: { ...f.row, raw_document_body: 'must not escape' },
  } });
  const response = await h.app.inject({
    method: 'GET',
    url: '/graph-worker/v1/source/' + h.f.run.run_id + '/rows/finance/' +
      h.f.item.enrichment_row_sha256 + '.json',
    headers: { authorization: 'Bearer cfo' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes('must not escape'), false);
  await h.app.close();
});

test('operations use legal CAS transitions and results remain create-only', async () => {
  const h = await harness();
  const decisionResponse = await h.app.inject({
    method: 'POST', url: '/graph-worker/v1/authorize',
    headers: authHeaders, payload: authorizeRequest(h.f),
  });
  assert.equal(decisionResponse.statusCode, 200);
  const decision = decisionResponse.json();
  const spec = {
    authorization_ref: decision.decision_ref,
    authorization_sha256: H(helper.canonical({
      authorized: true, decision_ref: decision.decision_ref,
    })),
    extractor_bundle_sha256: H('reviewed extractor bundle'),
    extractor_version: 'codex-subscription-extractor-v1',
    input_sha256: h.f.inputSha,
    login_before_model_contract: 'codex-login-status-before-model-exec-v1',
    model: 'gpt-5.6-luna', provider: 'codex-chatgpt-subscription',
    purpose: h.f.run.purpose, source_id: h.f.sourceId,
    source_version: h.f.item.document_version_id,
  };
  const id = 'subop_' + H(helper.canonical(spec));
  const operation = {
    operation_id: id, spec, state: 'claimed',
    claim_token: 'claim-token-123456789', revision: 0,
  };
  const envelope = {
    schema: 'subscription-model-operation-v1', operation_id: id,
    operation_sha256: H(helper.canonical(operation)), operation,
  };
  const url = '/graph-worker/v1/state/' + h.f.run.run_id + '/operations/' + id + '.json';
  const created = await h.app.inject({
    method: 'PUT', url, headers: { ...authHeaders, 'if-none-match': '*' },
    payload: helper.canonical(envelope),
  });
  assert.equal(created.statusCode, 201);
  const etag = created.headers.etag as string;

  const malformedDispatched = {
    ...operation, state: 'dispatched', revision: 1,
    dispatched_at: '2026-09-08T04:00:01.000Z', outcome_code: 'invented',
  };
  const malformedEnvelope = {
    ...envelope, operation_sha256: H(helper.canonical(malformedDispatched)),
    operation: malformedDispatched,
  };
  const malformed = await h.app.inject({
    method: 'PUT', url, headers: { ...authHeaders, 'if-match': etag },
    payload: helper.canonical(malformedEnvelope),
  });
  assert.equal(malformed.statusCode, 403);

  const dispatched = {
    ...operation, state: 'dispatched', revision: 1,
    dispatched_at: '2026-09-08T04:00:01.000Z',
  };
  const dispatchedEnvelope = {
    ...envelope, operation_sha256: H(helper.canonical(dispatched)),
    operation: dispatched,
  };
  const updated = await h.app.inject({
    method: 'PUT', url, headers: { ...authHeaders, 'if-match': etag },
    payload: helper.canonical(dispatchedEnvelope),
  });
  assert.equal(updated.statusCode, 201);

  const result = {
    operation_id: id, spec_sha256: H(helper.canonical(spec)),
    output: { provider: 'codex-chatgpt-subscription' },
  };
  const resultEnvelope = {
    schema: 'subscription-model-result-v1', operation_id: id,
    result_sha256: H(helper.canonical(result)), result,
  };
  const resultUrl = '/graph-worker/v1/state/' + h.f.run.run_id + '/results/' + id + '.json';
  const stored = await h.app.inject({
    method: 'PUT', url: resultUrl,
    headers: { ...authHeaders, 'if-none-match': '*' },
    payload: helper.canonical(resultEnvelope),
  });
  assert.equal(stored.statusCode, 201);
  const mutableResult = await h.app.inject({
    method: 'PUT', url: resultUrl,
    headers: { ...authHeaders, 'if-match': '"e1"' },
    payload: helper.canonical(resultEnvelope),
  });
  assert.equal(mutableResult.statusCode, 400);

  const incorrectComplete = {
    ...dispatched, state: 'complete', revision: 2,
    result_sha256: H('wrong stored result'),
  };
  const incorrectEnvelope = {
    ...envelope, operation_sha256: H(helper.canonical(incorrectComplete)),
    operation: incorrectComplete,
  };
  const mismatched = await h.app.inject({
    method: 'PUT', url,
    headers: { ...authHeaders, 'if-match': updated.headers.etag as string },
    payload: helper.canonical(incorrectEnvelope),
  });
  assert.equal(mismatched.statusCode, 412);

  const complete = {
    ...dispatched, state: 'complete', revision: 2,
    result_sha256: resultEnvelope.result_sha256,
  };
  const completeEnvelope = {
    ...envelope, operation_sha256: H(helper.canonical(complete)),
    operation: complete,
  };
  const completed = await h.app.inject({
    method: 'PUT', url,
    headers: { ...authHeaders, 'if-match': updated.headers.etag as string },
    payload: helper.canonical(completeEnvelope),
  });
  assert.equal(completed.statusCode, 201);
  await h.app.close();
});
