import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMemoryWrite, type MemoryWriteInput } from './memory-write.js';
import { memoryWriteIntent } from '../../agentstate/memory-idempotency.js';
import { requestContext } from '../../server/request-context.js';
import type { MemoryRecord } from '../../agentstate/memory.js';

const input: MemoryWriteInput = { agent: 'cto', kind: 'fact', text: 'Synthetic fixture only.', idempotency_key: 'fixture-capture-0001' };
const intent = memoryWriteIntent(input)!;
const record: MemoryRecord = { id: intent.id, agent: 'cto', type: 'memory', kind: 'fact', text: input.text,
  tags: [], source: null, created_at: '2026-09-13T00:00:00Z', idempotency: { payloadSha256: intent.payloadSha256 },
  indexing: { state: 'pending', attempts: 0, updated_at: '2026-09-13T00:00:00Z' } };
type Deps = NonNullable<Parameters<typeof handleMemoryWrite>[2]>;
function fixtures(existing: MemoryRecord | null) {
  let reads = 0;
  const forbidden = async (): Promise<never> => { throw new Error('unexpected side effect'); };
  const deps: Deps = { isConfigured: () => true, getMemory: async () => { reads++; return existing; }, embed: forbidden,
    detectSupersession: forbidden, writeMemory: forbidden, indexMemoryNow: forbidden, recordMemoryIndexOutcome: forbidden };
  return { deps, reads: () => reads };
}
const ctx = { correlationId: 'fixture', callerHash: 'fixture', callerAgent: 'cto', dryRun: false, acknowledgeWarning: false };
function call(value: MemoryWriteInput, deps: Deps, caller = 'cto', dryRun = false) {
  return requestContext.run({ callerAgent: caller, callerHash: 'fixture', correlationId: 'fixture' },
    () => handleMemoryWrite(value, { ...ctx, callerAgent: caller, dryRun }, deps));
}
test('keyed replay returns original receipt without embedding or projection writes', async () => {
  const f = fixtures(record);
  const result = await call(input, f.deps);
  const data = result.data as { written: boolean; replayed: boolean; indexed: boolean; record: MemoryRecord; persistence_state: string };
  assert.equal(data.written, true);
  assert.equal(data.replayed, true);
  assert.equal(data.indexed, false);
  assert.equal(data.persistence_state, 'committed');
  assert.deepEqual(data.record, record);
  assert.equal(f.reads(), 1);
});
test('changed payload with same key is a conflict, not a new record', async () => {
  const f = fixtures(record);
  await assert.rejects(call({ ...input, text: 'Different synthetic fact.' }, f.deps), /idempotency conflict/);
});
test('authorization and dry run precede idempotency lookup', async () => {
  for (const mode of ['forgery', 'personal', 'dry'] as const) {
    const f = fixtures(record);
    const caller = mode === 'forgery' ? 'coo' : mode === 'personal' ? 'clo-personal' : 'cto';
    const result = await call(input, f.deps, caller, mode === 'dry');
    assert.equal((result.data as { written: boolean }).written, false);
    assert.equal(f.reads(), 0);
  }
});
