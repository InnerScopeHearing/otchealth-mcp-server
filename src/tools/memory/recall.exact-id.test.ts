import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExactSharedIdQuery, recallHandler, resolveExactSharedId } from './recall.js';

test('recognizes the observed ID plus one unique marker token', () => {
  assert.deepEqual(parseExactSharedIdQuery('20260929-b7db22bc47ea COO-CHAT-20260929-01'), {
    agent: null,
    id: '20260929-b7db22bc47ea',
    marker: 'COO-CHAT-20260929-01',
  });
});

test('recognizes an agent-qualified ID plus marker', () => {
  assert.deepEqual(parseExactSharedIdQuery('chat_shared__20260925-4c3357980000 COO-CHAT-20260929-01'), {
    agent: 'chat_shared',
    id: '20260925-4c3357980000',
    marker: 'COO-CHAT-20260929-01',
  });
});

test('recognizes current and legacy bare ID forms', () => {
  assert.deepEqual(parseExactSharedIdQuery('20260925-4c3357980000'), {
    agent: null,
    id: '20260925-4c3357980000',
    marker: null,
  });
  assert.deepEqual(parseExactSharedIdQuery('20260619-014 CTO-CHAT-20260929-01'), {
    agent: null,
    id: '20260619-014',
    marker: 'CTO-CHAT-20260929-01',
  });
});

test('recognizes a lane-qualified legacy ID with its stored hash suffix', () => {
  assert.deepEqual(parseExactSharedIdQuery('cto__20261001-013-a1b2'), {
    agent: 'cto',
    id: '20261001-013-a1b2',
    marker: null,
  });
  assert.deepEqual(parseExactSharedIdQuery('20261001-013-A1B2'), {
    agent: null,
    id: '20261001-013-a1b2',
    marker: null,
  });
});

test('a bare suffixed ID respects the requested lane and rejects conflicting filters', async () => {
  const rows = [
    { id: '20261001-013-a1b2', agent: 'cto' },
    { id: '20261001-013-a1b2', agent: 'cro' },
  ];
  const read = async (agent: string | null) => rows.filter((row) => row.agent === agent);
  const bare = parseExactSharedIdQuery('20261001-013-a1b2')!;
  const qualified = parseExactSharedIdQuery('cto__20261001-013-a1b2')!;
  assert.deepEqual((await resolveExactSharedId(bare, 'cto', read)).matches, [rows[0]]);
  assert.deepEqual((await resolveExactSharedId(qualified, 'cro', read)).matches, []);
});

test('a suffixed legacy ID uses exact recall without semantic fallback', async () => {
  const row = { id: '20261001-013-a1b2', agent: 'cto', text: 'requested record' };
  let otherReads = 0;
  const result = await recallHandler(
    { query: 'cto__20261001-013-a1b2' },
    { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' },
    {
      isConfigured: () => true,
      semanticConfigured: () => false,
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: true }),
      readSharedAgent: async () => [row, { id: '20261001-013-ffff', agent: 'cto', text: 'related record' }],
      readSharedAll: async () => { otherReads++; return []; },
    },
  );
  assert.equal((result.data as { mode: string }).mode, 'exact-id');
  assert.deepEqual((result.data as { matches: unknown[] }).matches, [row]);
  assert.equal(otherReads, 0);
});

test('a suffixed legacy ID still respects lane-scoped retractions', async () => {
  const result = await recallHandler(
    { query: 'cto__20261001-013-a1b2' },
    { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' },
    {
      isConfigured: () => true,
      getRetractionSnapshot: async () => ({ byAgent: new Map([['cto', new Set(['20261001-013-a1b2'])]]), verified: true }),
      readSharedAgent: async () => [{ id: '20261001-013-a1b2', agent: 'cto', text: 'retired' }],
    },
  );
  assert.equal((result.data as { mode: string }).mode, 'exact-id');
  assert.deepEqual((result.data as { matches: unknown[] }).matches, []);
});

test('a suffixed legacy ID fails closed when retraction authority is unavailable, with explicit audit access', async () => {
  const row = { id: '20261001-013-a1b2', agent: 'cto', text: 'historical record' };
  const context = { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' };
  const dependencies = {
    isConfigured: () => true,
    getRetractionSnapshot: async () => ({ byAgent: new Map<string, Set<string>>(), verified: false }),
    readSharedAgent: async () => [row],
  };
  const current = await recallHandler({ query: 'cto__20261001-013-a1b2' }, context, dependencies);
  const audit = await recallHandler({ query: 'cto__20261001-013-a1b2', include_superseded: true }, context, dependencies);
  assert.equal((current.data as { mode: string }).mode, 'degraded-retraction-authority');
  assert.deepEqual((audit.data as { matches: unknown[] }).matches, [row]);
  assert.equal((audit.data as { mode: string }).mode, 'exact-id-audit-history');
});

test('keeps natural-language phrases containing a stored ID on ranked recall', () => {
  assert.equal(parseExactSharedIdQuery('Find 20260929-b7db22bc47ea COO-CHAT-20260929-01'), null);
  assert.equal(parseExactSharedIdQuery('20260929-b7db22bc47ea what happened?'), null);
  assert.equal(parseExactSharedIdQuery('20260929-b7db22bc47ea details'), null);
  assert.equal(parseExactSharedIdQuery('20261001-013-a1b2 details'), null);
  assert.equal(parseExactSharedIdQuery('what changed in CFO notes?'), null);
});

test('bare ID plus agent filter reads only that agent feed', async () => {
  const rows = [
    { id: '20260925-4c3357980000', agent: 'chat_shared', text: 'requested note' },
    { id: '20260925-4c3357980001', agent: 'chat_shared', text: 'semantically related note' },
    { id: '20260925-4c3357980000', agent: 'cto', text: 'same bare ID in another lane' },
  ];
  const readAgents: Array<string | null> = [];
  const exactId = parseExactSharedIdQuery('20260925-4c3357980000')!;
  const result = await resolveExactSharedId(exactId, 'chat_shared', async (agent) => {
    readAgents.push(agent);
    return rows.filter((row) => row.agent === agent);
  });
  assert.deepEqual(readAgents, ['chat_shared']);
  assert.deepEqual(result, { handled: true, matches: [rows[0]] });
});

test('an exact miss is handled as empty and does not request fallback candidates', async () => {
  let reads = 0;
  const exactId = parseExactSharedIdQuery('20260925-4c3357980000 CFO-CHAT-20260929-01')!;
  const result = await resolveExactSharedId(exactId, null, async () => {
    reads++;
    return [{ id: '20260925-4c3357980001', agent: 'chat_shared' }];
  });
  assert.equal(reads, 1);
  assert.deepEqual(result, { handled: true, matches: [] });
});

test('recall handler rejects an embedded restricted agent before reading its feed', async () => {
  let feedReads = 0;
  const result = await recallHandler(
    { query: 'clo-personal__20260925-4c3357980000 CTO-CHAT-20260929-01' },
    { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' },
    {
      readSharedAgent: async () => {
        feedReads++;
        return [];
      },
      readSharedAll: async () => {
        feedReads++;
        return [];
      },
    },
  );
  assert.equal((result.data as { mode: string }).mode, 'ring-forbidden');
  assert.equal(feedReads, 0);
});

test('a suffixed legacy ID cannot bypass the restricted-agent gate', async () => {
  let feedReads = 0;
  const result = await recallHandler(
    { query: 'clo-personal__20261001-013-a1b2' },
    { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' },
    { readSharedAgent: async () => { feedReads++; return []; } },
  );
  assert.equal((result.data as { mode: string }).mode, 'ring-forbidden');
  assert.equal(feedReads, 0);
});

test('structured record IDs never fall back to unrelated semantic matches', async () => {
  let retrievals = 0;
  const context = { correlationId: 'test', callerHash: 'test', dryRun: false, acknowledgeWarning: false, callerAgent: 'cto' };
  const dependencies = {
    getRetractionSnapshot: async () => { retrievals++; return { byAgent: new Map<string, Set<string>>(), verified: true }; },
    cachedAgenticRecall: async () => { retrievals++; throw new Error('unexpected semantic call'); },
    readSharedAll: async () => { retrievals++; return []; },
  };
  for (const query of ['m_mui95fb5_d4a94838', 'cto__m_mui95fb5_d4a94838', `m_idem_${'a'.repeat(64)}`]) {
    for (const include_superseded of [false, true]) {
      const result = await recallHandler({ query, include_superseded }, context, dependencies as any);
      assert.equal((result.data as { mode: string }).mode, 'structured-id-unsupported');
      assert.equal((result.data as { lookup_performed: boolean }).lookup_performed, false);
      assert.deepEqual((result.data as { matches: unknown[] }).matches, []);
      assert.match(result.summary ?? '', /did not look it up/);
    }
  }
  assert.equal(retrievals, 0);
});