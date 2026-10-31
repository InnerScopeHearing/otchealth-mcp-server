import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCurrentRecallHits, filterCurrentRecallHitsWithSnapshot, recallHandler } from './recall.js';
import type { RetractionSnapshot } from '../../memory/retractions.js';

test('current recall removes a retired entry only from the superseding agent lane', () => {
  const hits = [
    { id: 'cto__20260915-001', agent: 'cto', text: 'retired CTO belief' },
    { id: 'cfo__20260915-001', agent: 'cfo', text: 'same bare ID, still current CFO belief' },
    { id: 'cto__20260915-002', agent: 'cto', text: 'current CTO correction' },
  ];

  const current = filterCurrentRecallHits(hits, new Map([
    ['cto', new Set(['20260915-001'])],
  ]));

  assert.deepEqual(current.map((hit) => hit.id), ['cfo__20260915-001', 'cto__20260915-002']);
});

test('current recall preserves all hits when no retraction exists', () => {
  const hits = [{ id: 'cto__current', agent: 'cto', text: 'current belief' }];
  assert.deepEqual(filterCurrentRecallHits(hits, new Map()), hits);
});

test('current recall filters before the result limit so a current hit survives retired higher ranks', () => {
  const hits = [
    { id: 'cto__stale-1', agent: 'cto' },
    { id: 'cto__stale-2', agent: 'cto' },
    { id: 'cto__stale-3', agent: 'cto' },
    { id: 'cto__current', agent: 'cto' },
  ];
  const current = filterCurrentRecallHits(hits, new Map([['cto', new Set(['stale-1', 'stale-2', 'stale-3'])]]));
  assert.deepEqual(current.slice(0, 1).map((hit) => hit.id), ['cto__current']);
});

test('audit-history mode explicitly retains superseded entries', () => {
  const hits = [{ id: 'cto__stale', agent: 'cto' }, { id: 'cto__current', agent: 'cto' }];
  const history = filterCurrentRecallHits(hits, new Map([['cto', new Set(['stale'])]]), true);
  assert.deepEqual(history, hits);
});

test('current recall fails closed when the retraction authority is unverified', () => {
  const hits = [{ id: 'cto__stale', agent: 'cto' }, { id: 'cto__current', agent: 'cto' }];
  const snapshot: RetractionSnapshot = { byAgent: new Map(), verified: false };

  assert.deepEqual(filterCurrentRecallHitsWithSnapshot(hits, snapshot), []);
  assert.deepEqual(filterCurrentRecallHitsWithSnapshot(hits, snapshot, true), hits);
});

const recallContext = { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' } as const;

test('recall handler reports degraded status for an exact ID when retractions are unverified', async () => {
  const result = await recallHandler(
    { query: 'cto__20260915-001' },
    recallContext,
    {
      readSharedAgent: async () => [{ id: '20260915-001', agent: 'cto', text: 'stale' }],
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: false }),
      isConfigured: () => true,
    },
  );
  assert.equal((result.data as { mode: string }).mode, 'degraded-retraction-authority');
  assert.match(result.summary ?? '', /retraction authority/i);
});

test('exact audit-history recall remains available while retraction authority is unverified', async () => {
  const row = { id: '20260915-001', agent: 'cto', text: 'historical row' };
  const result = await recallHandler(
    { query: 'cto__20260915-001', include_superseded: true },
    recallContext,
    {
      readSharedAgent: async () => [row],
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: false }),
      isConfigured: () => true,
    },
  );
  assert.deepEqual((result.data as { matches: unknown[] }).matches, [row]);
  assert.equal((result.data as { mode: string }).mode, 'exact-id-audit-history');
});

test('exact current recall applies verified lane-scoped retractions', async () => {
  const result = await recallHandler(
    { query: 'cto__20260915-001' },
    recallContext,
    {
      readSharedAgent: async () => [{ id: '20260915-001', agent: 'cto', text: 'stale' }],
      getRetractionSnapshot: async () => ({ byAgent: new Map([['cto', new Set(['20260915-001'])]]), verified: true }),
      isConfigured: () => true,
    },
  );
  assert.deepEqual((result.data as { matches: unknown[] }).matches, []);
});

test('non-exact recall uses the injected shared feed and returns a verified current result', async () => {
  const current = { id: 'cto__20260915-002', agent: 'cto', type: 'note', text: 'current context', tags: [], source: '' };
  const result = await recallHandler(
    { query: 'current context' },
    recallContext,
    {
      readSharedAll: async () => [current],
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: true }),
      isConfigured: () => true,
      semanticConfigured: () => false,
    },
  );
  assert.deepEqual((result.data as { matches: unknown[] }).matches, [current]);
  assert.equal((result.data as { mode: string }).mode, 'keyword');
});

test('normal non-exact recall preflights retractions before provider retrieval', async () => {
  let agenticCalls = 0;
  let semanticCalls = 0;
  const result = await recallHandler(
    { query: 'should not retrieve' },
    recallContext,
    {
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: false }),
      cachedAgenticRecall: async () => {
        agenticCalls++;
        throw new Error('agentic provider must not run');
      },
      semanticConfigured: () => true,
      semanticSearch: async () => {
        semanticCalls++;
        throw new Error('semantic provider must not run');
      },
    },
  );
  assert.equal((result.data as { mode: string }).mode, 'degraded-retraction-authority');
  assert.equal(agenticCalls, 0);
  assert.equal(semanticCalls, 0);
});

test('verified agentic recall returns current results through the handler', async () => {
  const row = { id: 'cto__20260915-003', agent: 'cto', text: 'agentic current result' };
  let agenticCalls = 0;
  const result = await recallHandler(
    { query: 'agentic current result' },
    recallContext,
    {
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: true }),
      cachedAgenticRecall: async () => {
        agenticCalls++;
        return { mode: 'agentic-hybrid', results: [row], subQueries: ['agentic current result'], cacheHit: false };
      },
      isConfigured: () => true,
      semanticConfigured: () => false,
    },
  );
  assert.equal(agenticCalls, 1);
  assert.deepEqual((result.data as { matches: unknown[] }).matches, [row]);
  assert.equal((result.data as { mode: string }).mode, 'agentic-hybrid');
});

test('authority becoming unverified during provider retrieval blocks the result', async () => {
  const row = { id: 'cto__20260915-004', agent: 'cto', text: 'must not return stale' };
  let snapshotCalls = 0;
  let agenticCalls = 0;
  const result = await recallHandler(
    { query: 'must not return stale' },
    recallContext,
    {
      getRetractionSnapshot: async () => {
        snapshotCalls++;
        return { byAgent: new Map(), verified: snapshotCalls === 1 };
      },
      cachedAgenticRecall: async () => {
        agenticCalls++;
        return { mode: 'agentic-hybrid', results: [row], subQueries: ['must not return stale'], cacheHit: false };
      },
      isConfigured: () => true,
      semanticConfigured: () => false,
    },
  );
  assert.equal(agenticCalls, 1);
  assert.equal(snapshotCalls, 2);
  assert.equal((result.data as { mode: string }).mode, 'degraded-retraction-authority');
  assert.deepEqual((result.data as { matches: unknown[] }).matches, []);
});
