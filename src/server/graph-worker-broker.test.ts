import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {
  graphWorkerBrokerTest as helper,
  registerGraphWorkerBrokerRoutes,
  type GraphWorkerBrokerDeps,
} from './graph-worker-broker.js';

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
function fixture() {
  const row = {
    path: 'finance/report.txt', sha256: H('source bytes'), sidecar: true,
    enriched: true, enriched_sha256: H('source bytes'), err: null,
    doc_date: '2026-09-01', entity: 'Synthetic Co', entities: ['Synthetic Co'],
    named_entities_orgs: ['Synthetic Co'], named_entities_people: [],
    signatories: [], counterparty: null,
  };
  const sourceVersion = row.sha256;
  const sourcePathHash = H(row.path);
  const authority = {
    source_room: 'finance', source_index: 'finance-cfo-source-docs',
    policy_ref: 'gateway:isLaneAllowed',
  };
  const documentVersionId = 'docv_' + H('graph-assertion-v2\0' + helper.canonical({
    authority, source_path_hash: sourcePathHash, source_version: sourceVersion,
  }));
  const item = {
    ordinal: 0, room: 'finance', document_version_id: documentVersionId,
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
    purpose: 'company_graph_backfill', scope: 'finance',
    run_version: 'pilot-v1', manifest_sha256: manifest.manifest_sha256,
  };
  const run = { ...runContent, run_id: 'run_' + H(helper.canonical(runContent)) };
  const binding = {
    authenticated_caller: 'cfo' as const, run,
    room: 'finance' as const, source_index: 'finance-cfo-source-docs',
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
    schema: 'catalog-mention-snapshot-v1', room: 'finance',
    document_version_id: documentVersionId, row,
  };
  const inputSha = helper.metadataInputSha(row, item, 'finance');
  return {
    row, item, manifest, run, binding, policy, active, sourceId,
    sourceEnvelope, inputSha,
  };
}
function headers(etag = '"e1"') {
  return new Headers({ etag, 'content-type': 'application/json' });
}
async function harness(options: {
  caller?: string; policy?: unknown; active?: unknown; row?: unknown; transportError?: boolean;
} = {}) {
  const f = fixture();
  let revision = 1;
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const put = (key: string, value: unknown, etag = '"e1"') =>
    objects.set(key, { body: Buffer.from(helper.canonical(value)), etag });
  put(helper.statePrefix(f.binding) + '/active-runs/' +
    helper.bindingHash(f.run) + '.json', options.active ?? f.active);
  put(helper.SOURCE_PREFIX + '/manifests/' + f.manifest.manifest_sha256 + '.json',
    f.manifest);
  put(helper.SOURCE_PREFIX + '/rows/finance/' + f.item.enrichment_row_sha256 + '.json',
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
  registerGraphWorkerBrokerRoutes(app, {
    authenticate: async (request) => ({
      caller_hash: H('caller'), raw_token: 'test-only',
      caller_agent: options.caller ??
        (request.headers.authorization === 'Bearer cto' ? 'cto' : 'cfo'),
      connector_surface: true, m365_static_auth: false,
    }),
    bindingsJson: () => JSON.stringify(options.policy ?? f.policy),
    now: () => NOW,
    s3,
  });
  await app.ready();
  return { app, f, objects };
}
const authHeaders = { authorization: 'Bearer cfo', 'content-type': 'application/json' };

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
  await h.app.close();
});
