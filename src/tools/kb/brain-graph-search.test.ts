import test from 'node:test';
import assert from 'node:assert/strict';
import { graphScopeFor, handleBrainGraphSearch, hasMeaningfulOverlap, isCleanRetrievedText } from './brain-graph-search.js';
import { mayOffloadToolResult } from '../result-store.js';

const ctx = (callerAgent: string) => ({ callerAgent, callerHash: 'synthetic', correlationId: 'synthetic', dryRun: false, acknowledgeWarning: false });
const root = 's3://otchealth-finance-legal-dr-55c84f6b/graph-trial/20260913/managed-graphrag/';
const matter = 'personal-civil-cv0057318';
const row = (group = 'company', uri = root + group + '/test.txt') => ({ content: { text: 'Synthetic Organization X signed contract Y.' }, location: { type: 'S3', s3Location: { uri } }, metadata: { source_group: group, ...(group === 'personal' ? { matter_id: matter } : {}), source_id: 'a'.repeat(64), text_sha256: 'b'.repeat(64), source_sha256: 'c'.repeat(64), source_version: 'sha256:' + 'c'.repeat(64), private_extra: 'must not be copied' }, score: 0.8 });
function harness(response: () => Response = () => Response.json({ retrievalResults: [row()] })) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const deps = { config: () => ({ enabled: true, kbId: 'ABCDEFGHIJ' }), credentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }), fetch: (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return response(); }) as typeof fetch };
  return { deps, calls };
}

test('coarse company graph access requires the executive ring, while personal graph access remains protected', async () => {
  for (const caller of ['cfo', 'clo', 'cpo', 'cco']) {
    assert.equal(graphScopeFor(caller), 'company');
    assert.equal(graphScopeFor(caller, 'company'), 'company');
    assert.equal(graphScopeFor(caller, 'personal'), null);
    assert.equal(graphScopeFor(caller, 'all'), null);
  }
  for (const caller of ['clo-personal', 'exec']) {
    assert.equal(graphScopeFor(caller), 'personal');
    assert.equal(graphScopeFor(caller, 'company'), 'company');
    assert.equal(graphScopeFor(caller, 'personal'), 'personal');
    assert.equal(graphScopeFor(caller, 'all'), null);
  }
  assert.equal(graphScopeFor('cto'), null);
  assert.equal(graphScopeFor('cto', 'company_shared'), 'company_shared');
  for (const scope of ['company', 'personal', 'all'] as const) {
    assert.equal(graphScopeFor('cto', scope), null, `cto/${scope}`);
  }
  for (const caller of ['cto', 'external', '']) {
    const h = harness(); h.deps.credentials = async () => { throw new Error('must not resolve'); };
    const result: any = await handleBrainGraphSearch({ query: 'X relates to Y' }, ctx(caller), h.deps);
    assert.equal(result.data.error, 'forbidden_ring'); assert.equal(h.calls.length, 0);
  }
});

test('department seats retrieve only their own isolated source group', async () => {
  const cases = [
    ['coo', 'operations', root + 'company/operations/test.txt'],
    ['cro', 'revenue', root + 'company/revenue/test.txt'],
    ['developer', 'engineering', root + 'company/engineering/test.txt'],
  ] as const;
  for (const [caller, scope, uri] of cases) {
    assert.equal(graphScopeFor(caller), scope, caller);
    assert.equal(graphScopeFor(caller, scope), scope, caller);
    assert.equal(graphScopeFor(caller, 'company'), null, caller);
    assert.equal(graphScopeFor(caller, 'personal'), null, caller);
    const h = harness(() => Response.json({ retrievalResults: [row(scope, uri)] }));
    const allowed: any = await handleBrainGraphSearch({ query: 'synthetic' }, ctx(caller), h.deps);
    assert.equal(allowed.data.scope, scope, caller);
    assert.equal(allowed.data.count, 1, caller);
    assert.deepEqual(
      JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter,
      { equals: { key: 'source_group', value: scope } },
      caller,
    );
    const denied: any = await handleBrainGraphSearch({ query: 'synthetic', scope: 'company' }, ctx(caller), h.deps);
    assert.equal(denied.data.error, 'forbidden_ring', caller);
    assert.equal(h.calls.length, 1, caller);
  }
});

test('CTO can retrieve only the separate company_shared projection', async () => {
  const h = harness(() => Response.json({ retrievalResults: [
    row('company_shared', root + 'company_shared/projection.txt'),
    row('company', root + 'company/test.txt'),
    row('company_shared', root + 'company/projection.txt'),
  ] }));
  const allowed: any = await handleBrainGraphSearch({ query: 'synthetic', scope: 'company_shared' }, ctx('cto'), h.deps);
  assert.equal(allowed.data.scope, 'company_shared');
  assert.equal(allowed.data.count, 1);
  assert.deepEqual(allowed.data.matches.map((match: any) => match.source_uri), [root + 'company_shared/projection.txt']);
  assert.deepEqual(
    JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter,
    { equals: { key: 'source_group', value: 'company_shared' } },
  );

  const denied = harness();
  let credentialCalls = 0;
  denied.deps.credentials = async () => { credentialCalls++; return { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }; };
  for (const scope of [undefined, 'company', 'personal', 'all'] as const) {
    const result: any = await handleBrainGraphSearch({ query: 'synthetic', ...(scope === undefined ? {} : { scope }) }, ctx('cto'), denied.deps);
    assert.equal(result.data.error, 'forbidden_ring', `cto/${scope ?? 'omitted'}`);
  }
  assert.equal(denied.calls.length, 0);
  assert.equal(credentialCalls, 0);
});

test('every executive company graph seat reaches only the company-labelled corpus', async () => {
  for (const caller of ['cfo', 'clo', 'cpo', 'cco']) {
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
  for (const caller of ['clo-personal', 'exec']) {
    const h = harness();
    const allowed: any = await handleBrainGraphSearch({ query: 'synthetic', scope: 'company' }, ctx(caller), h.deps);
    assert.equal(allowed.data.scope, 'company', caller);
    assert.equal(h.calls.length, 1, `${caller} should make exactly one company retrieval`);
    assert.deepEqual(
      JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter,
      { equals: { key: 'source_group', value: 'company' } },
      caller,
    );
  }
});

test('CFO request signs exact configured endpoint and enforced company label', async () => {
  const h = harness(); const result: any = await handleBrainGraphSearch({ query: 'organization contract', top: 2 }, ctx('cfo'), h.deps);
  assert.equal(h.calls.length, 1); const call = h.calls[0]!;
  assert.equal(call.url, 'https://bedrock-agent-runtime.us-east-1.amazonaws.com/knowledgebases/ABCDEFGHIJ/retrieve');
  assert.equal(call.init?.redirect, 'error');
  assert.deepEqual(JSON.parse(String(call.init?.body)).retrievalConfiguration.vectorSearchConfiguration, { numberOfResults: 2, filter: { equals: { key: 'source_group', value: 'company' } } });
  assert.match(String((call.init?.headers as any).Authorization), /us-east-1\/bedrock\/aws4_request/);
  assert.equal(result.data.count, 1); assert.equal(result.data.answer_generated, false);
  assert.equal(result.data.matches[0].citation, 'graph:1'); assert.equal(JSON.stringify(result).includes('must not be copied'), false);
});

test('personal legal query requires and enforces one exact matter', async () => {
  const h = harness(() => Response.json({ retrievalResults: [row(), row('personal'), { ...row(), location: { type: 'S3', s3Location: { uri: 's3://another-bucket/test.txt' } } }] }));
  const cfo: any = await handleBrainGraphSearch({ query: 'synthetic', top: 4 }, ctx('cfo'), h.deps);
  assert.equal(cfo.data.count, 1); assert.equal(cfo.data.withheld_count, 2);
  const missing: any = await handleBrainGraphSearch({ query: 'synthetic', top: 4 }, ctx('clo-personal'), h.deps);
  assert.equal(missing.data.error, 'matter_id_required'); assert.equal(h.calls.length, 1);
  const clo: any = await handleBrainGraphSearch({ query: 'synthetic', matter_id: matter, top: 4 }, ctx('clo-personal'), h.deps);
  assert.equal(clo.data.count, 1); assert.equal(clo.data.matter_filter_applied, true);
  assert.deepEqual(JSON.parse(String(h.calls[1]?.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter, {
    andAll: [{ equals: { key: 'source_group', value: 'personal' } }, { equals: { key: 'matter_id', value: matter } }],
  });
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
  assert.equal(result.data.count, 1);
  assert.equal(result.data.duplicate_withheld_count, 2);
  assert.equal(result.data.withheld_count, 4);
  assert.deepEqual(result.data.matches.map((match: any) => match.source_uri), [root + 'company/test.txt']);
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
  await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids, matter_id: matter }, ctx('clo-personal'), h.deps);
  assert.deepEqual(JSON.parse(String(h.calls[0]!.init?.body)).retrievalConfiguration.vectorSearchConfiguration.filter, {
    andAll: [{ equals: { key: 'source_group', value: 'personal' } }, { equals: { key: 'matter_id', value: matter } }, { in: { key: 'source_id', value: ids } }],
  });
  for (const caller of ['cto', 'coo', 'cro', 'developer', 'external']) {
    assert.equal((await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids }, ctx(caller), h.deps) as any).data.error, 'forbidden_ring');
  }
  assert.equal((await handleBrainGraphSearch({ query: 'synthetic', source_ids: ids, scope: 'all' }, ctx('cfo'), h.deps) as any).data.error, 'forbidden_ring');
  assert.equal(h.calls.length, 1);
});

test('personal retrieval rejects cross-matter rows, corrupted text, irrelevant text, and duplicate hashes', async () => {
  const valid = row('personal');
  const duplicate = { ...valid, metadata: { ...valid.metadata, source_id: 'd'.repeat(64) }, score: 0.7 };
  const otherMatter = { ...valid, metadata: { ...valid.metadata, matter_id: 'personal-divorce-dr0067153', source_id: 'e'.repeat(64), text_sha256: 'e'.repeat(64) } };
  const corrupt = { ...valid, content: { text: '\u0000\ufffd\u0001broken' }, metadata: { ...valid.metadata, source_id: 'f'.repeat(64), text_sha256: 'f'.repeat(64) } };
  const irrelevant = { ...valid, content: { text: 'Completely unrelated words.' }, metadata: { ...valid.metadata, source_id: '1'.repeat(64), text_sha256: '1'.repeat(64) } };
  const h = harness(() => Response.json({ retrievalResults: [valid, duplicate, otherMatter, corrupt, irrelevant] }));
  const result: any = await handleBrainGraphSearch({ query: 'organization contract', scope: 'personal', matter_id: matter, top: 8 }, ctx('clo-personal'), h.deps);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.withheld_count, 1);
  assert.equal(result.data.quality_withheld_count, 1);
  assert.equal(result.data.relevance_withheld_count, 1);
  assert.equal(result.data.duplicate_withheld_count, 1);
  assert.equal(result.data.matches[0].matter_id, matter);
  assert.equal(result.data.matches[0].source_version, 'sha256:' + 'c'.repeat(64));
});

test('negative synthetic identifiers produce a true no-match result', async () => {
  const h = harness(() => Response.json({ retrievalResults: [{ ...row('personal'), content: { text: 'A clean but unrelated legal passage.' }, score: 2.1 }] }));
  const result: any = await handleBrainGraphSearch({ query: 'ZXQ-NEVER-EXISTS-94731 QVJ-NO-MATCH-62804', scope: 'personal', matter_id: matter }, ctx('clo-personal'), h.deps);
  assert.equal(result.data.count, 0);
  assert.equal(result.data.relevance_withheld_count, 1);
  assert.equal(hasMeaningfulOverlap('known contract', 'The contract is known.'), true);
  assert.equal(isCleanRetrievedText('clean\ntext'), true);
  assert.equal(isCleanRetrievedText('\u0000broken'), false);
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
  const r: any = await handleBrainGraphSearch({ query: 'xxx' }, ctx('clo'), h.deps);
  assert.equal(r.data.matches[0].text.length, 3000); assert.equal(r.data.matches[0].truncated, true);
  assert.equal(mayOffloadToolResult('brain_graph_search'), false);
});
