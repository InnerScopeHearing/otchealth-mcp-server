import assert from 'node:assert/strict';
import test from 'node:test';

for (const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'})) process.env[key]??=value;
const { requestContext } = await import('../../server/request-context.js');
const { createCompanySharedSyntheticRelationshipFixture, createCompanySharedSyntheticRelationshipQuery } = await import('../../server/company-shared-synthetic-relationship.mjs');
const { queryCompanySharedSyntheticHistories } = await import('../../server/relationship-query/durable-query.mjs');
const { registerCompanySharedSyntheticRelationshipQuery } = await import('./company-shared-relationship-query.js');
type Handler = (args: Record<string, unknown>) => Promise<any>;
const callerHash = 'a'.repeat(64);
function capture(injected?: (input: any) => Promise<unknown>) {
  let handler: Handler | undefined;
  const server = { registerTool(_name: string, _config: unknown, candidate: Handler) { handler = candidate; return { remove() {} }; } };
  registerCompanySharedSyntheticRelationshipQuery(server as never, () => callerHash, injected);
  assert.ok(handler);
  return handler;
}
function invoke(handler: Handler, callerAgent: string, connectorSurface: boolean, args: Record<string, unknown>) {
  return requestContext.run({ callerHash, correlationId: 'synthetic', callerAgent, connectorSurface }, () => handler(args));
}

test('CTO shared typed route returns only a replayed synthetic X-to-Y-to-Z path and immutable citations', async () => {
  const handler = capture();
  const result = await invoke(handler, 'cto', true, { subject_id: 'X', object_id: 'Z' });
  const answer = result.structuredContent.result.result;
  assert.equal(answer.status, 'qualified');
  assert.equal(answer.query_scope, 'company_shared');
  assert.equal(answer.synthetic_only, true);
  assert.equal(answer.evidence.length, 2);
  assert.deepEqual(answer.evidence.map((edge: any) => [edge.candidate.subject, edge.candidate.object]), [['X', 'Y'], ['Y', 'Z']]);
  assert.equal(answer.citations.length, 2);
  assert.ok(answer.citations.every((citation: any) => /^[a-f0-9]{64}$/.test(citation.source_id) && /^sha256:[a-f0-9]{64}$/.test(citation.source_version) && /^cite_[a-f0-9]{64}$/.test(citation.citation_id)));
});
test('shared typed route denies other callers and its strict schema rejects caller-selected history, storage, or partition', async () => {
  const handler = capture();
  for (const [agent, connector] of [['cfo', true], ['clo', true], ['clo-personal', true], ['cto', false]] as const) {
    const denied = await invoke(handler, agent, connector, { subject_id: 'X', object_id: 'Z' });
    assert.equal(denied.structuredContent.result.error, 'forbidden_graph_scope');
  }
  for (const field of ['histories', 'store', 'producer_id', 'partition', 'scope']) {
    const rejected = await invoke(handler, 'cto', true, { subject_id: 'X', object_id: 'Z', [field]: 'finance' });
    assert.equal(rejected.isError, true, field);
  }
});

test('synthetic immutable replay rejects a wrong partition or citation bound to another source version', async () => {
  const fixture = createCompanySharedSyntheticRelationshipFixture();
  const query = { subject_id: fixture.entityIds.X, object_id: fixture.entityIds.Z };
  const wrongPartition = structuredClone(fixture.entry);
  wrongPartition.history.run.scope = 'finance';
  assert.throws(() => queryCompanySharedSyntheticHistories({ entries: [wrongPartition], query, isCurrentCitation: () => true }), /shared_synthetic_partition_invalid/);
  const wrongSource = structuredClone(fixture.entry);
  wrongSource.inputs[0].binding.room = 'finance';
  assert.throws(() => queryCompanySharedSyntheticHistories({ entries: [wrongSource], query, isCurrentCitation: () => true }), /shared_synthetic_partition_invalid|durable_query_replay_divergence|shared_synthetic_citation_invalid/);
  const badCitation = structuredClone(fixture.entry);
  badCitation.citation_receipts[0].source_version = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => queryCompanySharedSyntheticHistories({ entries: [badCitation], query, isCurrentCitation: () => true }), /shared_synthetic_citation_invalid/);
});

test('a revoked synthetic source version cannot produce a qualified path', async () => {
  const query = createCompanySharedSyntheticRelationshipQuery({ isCurrentCitation: () => false });
  const answer: any = await query({ subject_id: 'X', object_id: 'Z' });
  assert.notEqual(answer.status, 'qualified');
  assert.equal(answer.synthetic_only, true);
  assert.deepEqual(answer.citations, []);
});

