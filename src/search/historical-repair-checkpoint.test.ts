import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHistoricalRepairCheckpointStore,
  HISTORICAL_REPAIR_LEASE_MS,
  historicalRepairCheckpointId,
  normalizeHistoricalRepairCheckpoint,
} from './historical-repair-checkpoint.js';

const checkpoint = {
  version: 'memory-index-repair-v1' as const,
  agent: 'cfo',
  after_id: 'm_200',
  pending_ids: ['m_100'],
};
const RUN_A = '00000000-0000-4000-8000-000000000001';
const RUN_B = '00000000-0000-4000-8000-000000000002';

function memoryBackend() {
  let row: { doc: Record<string, unknown>; etag: string } | null = null;
  let revision = 0;
  let now = Date.parse('2026-09-09T21:00:00.000Z');
  let throwAfterReplace = false;
  const deps = {
    readDoc: async () => row ? structuredClone(row) : null,
    createDoc: async (_collection: string, _partition: string, doc: Record<string, unknown>) => {
      if (row) throw new Error('duplicate');
      row = { doc: structuredClone(doc), etag: `etag-${++revision}` };
      return { ok: true, etag: row.etag };
    },
    replaceDoc: async (_collection: string, _partition: string, _id: string, doc: Record<string, unknown>, etag?: string) => {
      if (!row || row.etag !== etag) return { ok: false };
      row = { doc: structuredClone(doc), etag: `etag-${++revision}` };
      if (throwAfterReplace) { throwAfterReplace = false; throw new Error('synthetic response loss'); }
      return { ok: true, etag: row.etag };
    },
    now: () => now,
  };
  return {
    deps,
    get row() { return row; },
    advance(ms: number) { now += ms; },
    loseNextReplaceResponse() { throwAfterReplace = true; },
  };
}

test('checkpoint normalization is partition-bound, bounded, and deterministic', () => {
  assert.deepEqual(
    normalizeHistoricalRepairCheckpoint({ ...checkpoint, pending_ids: ['m_100', 'm_050', 'm_100'] }, 'cfo'),
    { ...checkpoint, pending_ids: ['m_050', 'm_100'] },
  );
  assert.throws(() => normalizeHistoricalRepairCheckpoint({ ...checkpoint, agent: 'cto' }, 'cfo'), /checkpoint_invalid/);
  assert.throws(() => normalizeHistoricalRepairCheckpoint({ ...checkpoint, text: 'forbidden' }, 'cfo'), /checkpoint_invalid/);
  assert.equal(historicalRepairCheckpointId('cfo', 'memory-exec'), 'checkpoint.cfo.memory-exec');
});

test('durable checkpoint survives cache TTL and contains metadata only', async () => {
  const backend = memoryBackend();
  const store = createHistoricalRepairCheckpointStore(backend.deps);
  const lease = await store.acquire('cfo', 'memory-exec', RUN_A);
  assert.equal(lease.acquired, true);
  assert.equal(backend.row?.doc.ttl, -1);
  assert.equal(backend.row?.doc.cacheScope, 'memory-index-repair-v1');
  assert.equal('text' in (backend.row?.doc ?? {}), false);
  assert.equal(JSON.stringify(backend.row?.doc).includes('embedding'), false);
  if (!lease.acquired) return;
  assert.equal(await store.commit(lease, checkpoint), true);
  assert.deepEqual((await store.load('cfo', 'memory-exec')).checkpoint, checkpoint);
});

test('two processes cannot enter one paid repair pass and an expired lease is recoverable', async () => {
  const backend = memoryBackend();
  const firstProcess = createHistoricalRepairCheckpointStore(backend.deps);
  const secondProcess = createHistoricalRepairCheckpointStore(backend.deps);
  const first = await firstProcess.acquire('cfo', 'memory-exec', RUN_A);
  assert.equal(first.acquired, true);
  assert.deepEqual(await secondProcess.acquire('cfo', 'memory-exec', RUN_B), { acquired: false });
  backend.advance(HISTORICAL_REPAIR_LEASE_MS + 1);
  const recovered = await secondProcess.acquire('cfo', 'memory-exec', RUN_B);
  assert.equal(recovered.acquired, true);
  if (!first.acquired) return;
  assert.equal(await firstProcess.commit(first, checkpoint), false, 'stale worker cannot commit over recovered lease');
});

test('commit verifies durable state after an unknown write outcome', async () => {
  const backend = memoryBackend();
  const store = createHistoricalRepairCheckpointStore(backend.deps);
  const lease = await store.acquire('cfo', 'memory-exec', RUN_A);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  backend.loseNextReplaceResponse();
  assert.equal(await store.commit(lease, checkpoint), true);
  const loaded = await store.load('cfo', 'memory-exec');
  assert.deepEqual(loaded.checkpoint, checkpoint);
  assert.equal(loaded.lease_active, false);
});

test('malformed or expiring durable state fails before it can become a repair cursor', async () => {
  for (const doc of [
    { type: 'wrong' },
    { id: historicalRepairCheckpointId('cfo', 'memory-exec'), cacheScope: 'memory-index-repair-v1', type: 'memory_index_repair_checkpoint', agent: 'cfo', index: 'memory-exec', checkpoint, lease: null, last_completed_run_id: null, ttl: 604800 },
  ]) {
    const store = createHistoricalRepairCheckpointStore({
      readDoc: async () => ({ etag: 'etag-1', doc }),
      createDoc: async () => ({ ok: true, etag: 'etag-2' }),
      replaceDoc: async () => ({ ok: true, etag: 'etag-2' }),
      now: Date.now,
    });
    await assert.rejects(() => store.load('cfo', 'memory-exec'), /checkpoint_store_invalid/);
  }
});
