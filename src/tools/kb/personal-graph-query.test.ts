import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handlePersonalGraphQuery } from './personal-graph-query.js';

const ctx = (callerAgent: string) => ({ callerAgent, callerHash: 'synthetic', correlationId: 'synthetic', dryRun: false, acknowledgeWarning: false });
const matter = 'personal-civil-cv0057318';
const x = 'e'.repeat(64), y = 'f'.repeat(64), z = '1'.repeat(64);
const edge = { edge_id: 'edge-1', predicate_sha256: 'a'.repeat(64), document_sha256: 'b'.repeat(64), source_sha256: 'c'.repeat(64), anchor_sha256: 'd'.repeat(64), locator_sha256: 'e'.repeat(64), status: 'reviewed', reviewer_sha256: 'f'.repeat(64) };
function harness(rows: unknown[][] = [[edge], [edge], []]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const deps = { config: () => ({ enabled: true, graphId: 'g-ztex6q1l41' }), credentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }), fetch: (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init }); return Response.json({ results: rows[index++] }); }) as typeof fetch };
  return { deps, calls };
}

test('returns three separately proven exact pairs with provenance', async () => {
  const h = harness();
  const result: any = await handlePersonalGraphQuery({ matter_id: matter, x_entity_id: x, y_entity_id: y, z_entity_id: z }, ctx('clo-personal'), h.deps);
  assert.equal(result.data.complete_chain, true);
  assert.equal(result.data.direct_x_z_present, false);
  assert.equal(result.data.x_y[0].source_sha256, 'c'.repeat(64));
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.equal(call.url, 'https://neptune-graph.us-east-1.amazonaws.com/queries');
    assert.match(String((call.init?.headers as any).Authorization), /us-east-1\/neptune-graph\/aws4_request/);
    assert.equal((call.init?.headers as any).graphidentifier, 'g-ztex6q1l41');
    const body = JSON.parse(String(call.init?.body));
    assert.equal(body.parameters.matter_sha256, createHash('sha256').update(matter, 'utf8').digest('hex'));
    assert.equal(body.query.includes(body.parameters.left_entity_id), false);
    assert.match(body.query, /entity_sha256: \$left_entity_id/);
    assert.match(body.query, /status: 'reviewed'/);
  }
});

test('refuses every non-personal caller before credentials or network', async () => {
  const h = harness(); h.deps.credentials = async () => { throw new Error('must not resolve'); };
  for (const caller of ['exec', 'cfo', 'clo', 'cto', 'developer']) {
    const result: any = await handlePersonalGraphQuery({ matter_id: matter, x_entity_id: x, y_entity_id: y, z_entity_id: z }, ctx(caller), h.deps);
    assert.equal(result.data.error, 'forbidden_ring');
  }
  assert.equal(h.calls.length, 0);
});

test('invalid matter and malformed provider provenance fail closed', async () => {
  const h = harness([[{ ...edge, source_sha256: 'bad' }], [], []]);
  assert.equal((await handlePersonalGraphQuery({ matter_id: '../other', x_entity_id: x, y_entity_id: y, z_entity_id: z }, ctx('clo-personal'), h.deps) as any).data.error, 'invalid_input');
  assert.equal((await handlePersonalGraphQuery({ matter_id: matter, x_entity_id: x, y_entity_id: y, z_entity_id: z }, ctx('clo-personal'), h.deps) as any).data.error, 'neptune_query_failed');
});

test('pending and rejected graph edges can never satisfy a traversal', async () => {
  for (const status of ['pending', 'rejected']) {
    const h = harness([[{ ...edge, status }], [edge], []]);
    const result: any = await handlePersonalGraphQuery({ matter_id: matter, x_entity_id: x, y_entity_id: y, z_entity_id: z }, ctx('clo-personal'), h.deps);
    assert.equal(result.data.complete_chain, false, status);
    assert.equal(result.data.error, 'neptune_query_failed', status);
  }
});
