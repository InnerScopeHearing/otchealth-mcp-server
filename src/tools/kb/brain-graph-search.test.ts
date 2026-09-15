import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_GRAPH_RING, PERSONAL_GRAPH_RING, graphScopeFor, handleBrainGraphSearch } from './brain-graph-search.js';
import { mayOffloadToolResult } from '../result-store.js';

const ctx = (callerAgent: string) => ({ callerAgent, callerHash: 'synthetic', correlationId: 'synthetic', dryRun: false, acknowledgeWarning: false });
const root = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/';
const row = (group = 'company', uri = root + group + '/test.txt') => ({ content: { text: 'Synthetic Organization X signed contract Y.' }, location: { type: 'S3', s3Location: { uri } }, metadata: { source_group: group, source_id: 'a'.repeat(64), text_sha256: 'b'.repeat(64), private_extra: 'must not be copied' }, score: 0.8 });
function harness(response: () => Response = () => Response.json({ retrievalResults: [row()] })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deps = { config: () => ({ enabled: true, kbId: 'ABCDEFGHIJ' }), credentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }), fetch: (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(); }) as typeof fetch };
  return { deps, calls };
}

test('company graph ring is exactly the six company seats, while personal graph access remains protected', async () => {
  assert.deepEqual(COMPANY_GRAPH_RING, ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer']);
  assert.deepEqual(PERSONAL_GRAPH_RING, ['clo-personal']);
  for (const caller of COMPANY_GRAPH_RING) {
    assert.equal(graphScopeFor(caller), 'company');
    assert.equal(graphScopeFor(caller, 'company'), 'company');
    assert.equal(graphScopeFor(caller, 'personal'), null);
    assert.equal(graphScopeFor(caller, 'all'), null);
  }
  assert.equal(graphScopeFor('clo-personal'), 'all');
  assert.equal(graphScopeFor('clo-personal', 'company'), 'company');
  assert.equal(graphScopeFor('clo-personal', 'personal'), 'personal');
  assert.equal(graphScopeFor('clo-personal', 'all'), 'all');
  for (const caller of ['cpo', 'cco', 'exec', 'external', '']) {
    const h = harness(); h.deps.credentials = async () => { throw new Error('must not resolve'); };
    const result: any = await handleBrainGraphSearch({ query: 'X relates to Y' }, ctx(caller), h.deps);
    assert.equal(result.data.error, 'forbidden_ring'); assert.equal(h.calls.length, 0);
  }
});

test('every company graph seat reaches only the company-labelled corpus', async () => {
  for (const caller of COMPANY_GRAPH_RING) {
    const h = harness();
    const allowed: any = await handleBrainGraphSearch({ query: 'synthetic', scope: 'company' }, ctx(caller), h.deps);
    assert.equal(allowed.data.scope, 'company', caller);
    assert.equal(h.calls.length, 1, `${caller} should make exactly one company retrieval`);
    assert.deepEqual(
      JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter,
      { equals: { key: 'source_group', value: 'company' } },
      caller,
    );
    for (const scope of ['personal', 'all'] as const) {
      const denied: any = await handleBrainGraphSearch({ query: 'synthetic', scope }, ctx(caller), h.deps);
      assert.equal(denied.data.error, 'forbidden_ring', `${caller}/${scope}`);
      assert.equal(h.calls.length, 1, `${caller}/${scope} must not reach AWS`);
    }
  }
});

test('CFO request signs exact configured endpoint and enforced company label', async () => {
  const h = harness(); const result: any = await handleBrainGraphSearch({ query: 'X relates to Y', top: 2 }, ctx('cfo'), h.deps);
  assert.equal(h.calls.length, 1); const call = h.calls[0]!;
  assert.equal(call.url, 'https://bedrock-agent-runtime.us-east-1.amazonaws.com/knowledgebases/ABCDEFGHIJ/retrieve');
  assert.equal(call.init?.redirect, 'error');
  assert.deepEqual(JSON.parse(String(call.init?.body)).retrievalConfiguration.vectorSearchConfiguration, { numberOfResults: 2, filter: { equals: { key: 'source_group', value: 'company' } } });
  assert.match(String((call.init?.headers as any).Authorization), /us-east-1\/bedrock\/aws4_request/);
  assert.equal(result.data.count, 1); assert.equal(result.data.answer_generated, false);
  assert.equal(result.data.matches[0].citation, 'graph:1'); assert.equal(JSON.stringify(result).includes('must not be copied'), false);
});

test('personal legal query can return both labeled corpora; company seats withhold personal results', async () => {
  const h = harness(() => Response.json({ retrievalResults: [row(), row('personal'), { ...row(), location: { type: 'S3', s3Location: { uri: 's3://another-bucket/test.txt' } } }] }));
  const cfo: any = await handleBrainGraphSearch({ query: 'synthetic', top: 4 }, ctx('cfo'), h.deps);
  assert.equal(cfo.data.count, 1); assert.equal(cfo.data.withheld_count, 2);
  const clo: any = await handleBrainGraphSearch({ query: 'synthetic', top: 4 }, ctx('clo-personal'), h.deps);
  assert.equal(clo.data.count, 2); assert.equal(JSON.parse(String(h.calls[1]?.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter, undefined);
});

test('company retrieval admits existing, priority and capacity prefixes with matching source labels', async () => {
  const h = harness(() => Response.json({ retrievalResults: [
    row('company', root + 'company/test.txt'),
    row('company', root + 'company-priority/test.txt'),
    row('company', root + 'company-capacity/batch/test.txt'),
    row('company', root + 'company-capacity-other/test.txt'),
    row('personal', root + 'company-priority/test.txt'),
    row('personal', root + 'company-capacity/test.txt'),
    row('company', root + 'personal/test.txt'),
  ] }));
  const result: any = await handleBrainGraphSearch({ query: 'synthetic', top: 8 }, ctx('cfo'), h.deps);
  assert.equal(result.data.count, 3);
  assert.equal(result.data.withheld_count, 4);
  assert.deepEqual(result.data.matches.map((match: any) => match.source_uri), [
    root + 'company/test.txt', root + 'company-priority/test.txt',
    root + 'company-capacity/batch/test.txt',
  ]);
});

test('disabled or invalid deployment configuration cannot spend on retrieval', async () => {
  const h = harness(); h.deps.config = () => ({ enabled: false, kbId: 'ABCDEFGHIJ' });
  assert.equal((await handleBrainGraphSearch({ query: 'synthetic' }, ctx('clo'), h.deps) as any).data.mode, 'not_enabled');
  h.deps.config = () => ({ enabled: true, kbId: 'https://untrusted/' });
  assert.equal((await handleBrainGraphSearch({ query: 'synthetic' }, ctx('clo'), h.deps) as any).data.mode, 'unconfigured');
  assert.equal(h.calls.length, 0);
});

test('known source IDs narrow company retrieval and locally reject upstream filter violations', async () => {
  const target = 'a'.repeat(64);
  const other = { ...row(), metadata: { ...row().metadata, source_id: 'c'.repeat(64) } };
  const missingId = { ...row(), metadata: { source_group: 'company' } };
  const h = harness(() => Response.json({ retrievalResults: [other, missingId, row('personal'), row()], nextToken: 'opaque' }));
  const r: any = await handleBrainGraphSearch({ query: 'synthetic', source_ids: [target], top: 8 }, ctx('cfo'), h.deps);
  assert.deepEqual(JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter, {
    andAll: [{ equals: { key: 'source_group', value: 'company' } }, { in: { key: 'source_id', value: [target] } }],
  });
  assert.equal(r.data.count, 1); assert.equal(r.data.withheld_count, 3);
  assert.equal(r.data.matches[0].source_id, target);
  assert.equal(r.data.source_filter_applied, true); assert.equal(r.data.requested_source_count, 1);
  assert.equal(r.data.more_results_available, true);
});

test('source-ID narrowing preserves personal scope rules and cannot admit a forbidden caller', async () => {
  const ids = ['a'.repeat(64), 'c'.repeat(64)];
  const h = harness();
  await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids }, ctx('clo-personal'), h.deps);
  assert.deepEqual(JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter, { in: { key: 'source_id', value: ids } });
  await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids, scope: 'personal' }, ctx('clo-personal'), h.deps);
  assert.deepEqual(JSON.parse(String(h.calls[1]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter, {
    andAll: [{ equals: { key: 'source_group', value: 'personal' } }, { in: { key: 'source_id', value: ids } }],
  });
  for (const caller of ['cpo', 'cco', 'exec', 'external']) {
    assert.equal((await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids }, ctx(caller), h.deps) as any).data.error, 'forbidden_ring');
  }
  assert.equal((await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids, scope: 'all' }, ctx('cfo'), h.deps) as any).data.error, 'forbidden_ring');
  assert.equal(h.calls.length, 2);
});

test('empty, repeated, malformed, and oversized source-ID lists never call AWS', async () => {
  const h = harness(); h.deps.credentials = async () => { throw new Error('must not resolve'); };
  for (const source_ids of [[], ['a'.repeat(64), 'a'.repeat(64)], ['A'.repeat(64)], ['../source'], Array.from({ length: 6 }, (_, i) => String(i).repeat(64))]) {
    assert.equal((await handleBrainGraphSearch({ query: 'synthetic', source_ids }, ctx('cfo'), h.deps) as any).data.mode, 'invalid_request');
  }
  assert.equal(h.calls.length, 0);
});

test('unknown fields, oversized requests and unauthorized scope are rejected', async () => {
  const h = harness();
  for (const input of [{ query: 'synthetic', kbId: 'OVERRIDE01' }, { query: 'x'.repeat(2001) }, { query: 'test', top: 9 }]) {
    assert.equal((await handleBrainGraphSearch(input as any, ctx('clo'), h.deps) as any).data.mode, 'invalid_request');
  }
  assert.equal((await handleBrainGraphSearch({ query: 'test', scope: 'all' }, ctx('cfo'), h.deps) as any).data.error, 'forbidden_ring');
  assert.equal(h.calls.length, 0);
});

test('upstream failures are sanitized, with no retry and no generated fallback', async () => {
  const h = harness(() => new Response('private upstream body', { status: 403 }));
  const r: any = await handleBrainGraphSearch({ query: 'synthetic' }, ctx('clo'), h.deps);
  assert.equal(r.data.error, 'bedrock_http_403'); assert.equal(JSON.stringify(r).includes('private upstream body'), false); assert.equal(h.calls.length, 1);
  h.deps.fetch = async () => { throw new Error('private credential detail'); };
  assert.equal(JSON.stringify(await handleBrainGraphSearch({ query: 'synthetic' }, ctx('clo'), h.deps)).includes('private credential detail'), false);
});

test('large provider responses are rejected and returned passages remain bounded', async () => {
  const h = harness(() => Response.json({ retrievalResults: [{ ...row(), content: { text: 'x'.repeat(600000) } }] }));
  assert.equal((await handleBrainGraphSearch({ query: 'test' }, ctx('clo'), h.deps) as any).data.mode, 'unavailable');
  h.deps.fetch = async () => Response.json({ retrievalResults: [{ ...row(), content: { text: 'x'.repeat(6000) } }] });
  const r: any = await handleBrainGraphSearch({ query: 'test' }, ctx('clo'), h.deps);
  assert.equal(r.data.matches[0].text.length, 3000); assert.equal(r.data.matches[0].truncated, true);
  assert.equal(mayOffloadToolResult('brain_graph_search'), false);
});
