import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryRecord } from './memory.js';
import { memoryWriteIntent, persistMemoryOnce } from './memory-idempotency.js';

const KEY = 'memory-replay-key-0001';

function intent(agent = 'developer', text = 'synthetic memory'): NonNullable<ReturnType<typeof memoryWriteIntent>> {
  const value = memoryWriteIntent({
    agent,
    kind: 'fact',
    text,
    tags: ['synthetic'],
    source: 'unit test',
    idempotency_key: KEY,
  });
  assert.ok(value);
  return value;
}

function record(agent = 'developer', text = 'synthetic memory'): MemoryRecord {
  const writeIntent = intent(agent, text);
  return {
    id: writeIntent.id,
    type: 'memory',
    agent,
    kind: 'fact',
    text,
    tags: ['synthetic'],
    source: 'unit test',
    created_at: '2026-09-13T00:00:00.000Z',
    idempotency: { payloadSha256: writeIntent.payloadSha256 },
  };
}

test('memoryWriteIntent is stable for the same normalized agent and key', () => {
  const first = memoryWriteIntent({ agent: ' Developer ', kind: 'fact', text: 'first', idempotency_key: KEY });
  const second = memoryWriteIntent({ agent: 'developer', kind: 'decision', text: 'changed payload', idempotency_key: KEY });
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.id, second.id, 'the id is keyed by normalized agent plus operation key, not payload');
  assert.notEqual(first.payloadSha256, second.payloadSha256, 'changed payload is detected on replay');
});

test('memoryWriteIntent isolates the same operation key across agents', () => {
  const developer = intent('developer');
  const cto = intent('cto');
  assert.notEqual(developer.id, cto.id);
  assert.notEqual(developer.payloadSha256, cto.payloadSha256);
});

test('readback verifies content, not merely matching stored hash metadata', async () => {
  const requested = record();
  const changed = { ...requested, text: 'Unexpected changed content.' };
  await assert.rejects(persistMemoryOnce(requested, async () => {}, async () => changed), /idempotency conflict/);
});

test('readback retains the original explicit supersession separately from automatic supersession', async () => {
  const requested = record();
  requested.supersedes = 'automatically-detected-old-record';
  requested.idempotency!.requestedSupersedes = null;
  assert.deepEqual(await persistMemoryOnce(requested, async () => {}, async () => requested), requested);
});

test('two concurrent captures have one source winner and one replay observer', async () => {
  let stored: MemoryRecord | null = null;
  let replays = 0;
  let creates = 0;
  const create = async (value: MemoryRecord) => {
    if (stored) throw new Error('409');
    stored = value;
    creates++;
  };
  const read = async () => stored;
  const results = await Promise.all([1, 2].map(() => persistMemoryOnce(record(), create, read, () => { replays++; })));
  assert.equal(creates, 1);
  assert.equal(replays, 1);
  assert.deepEqual(results[0], results[1]);
});

test('persistMemoryOnce refuses a cross-agent record even if a faulty read returns the requested id', async () => {
  const requested = record('developer');
  // Synthetic hostile/faulty backend response: the id and request hash alone must not bridge
  // partitions or provenance between agents.
  const crossAgent = { ...requested, agent: 'cto' };
  let creates = 0;
  await assert.rejects(
    persistMemoryOnce(requested, async () => { creates += 1; }, async () => crossAgent),
    /memory idempotency conflict/,
  );
  assert.equal(creates, 0);
});

test('persistMemoryOnce replays a matching committed keyed record without a second create', async () => {
  const committed = record();
  let creates = 0;
  const actual = await persistMemoryOnce(
    committed,
    async () => { creates += 1; },
    async (id, agent) => (id === committed.id && agent === committed.agent ? committed : null),
  );
  assert.strictEqual(actual, committed);
  assert.equal(creates, 0);
});

test('persistMemoryOnce rejects a same-key payload conflict without creating', async () => {
  const requested = record('developer', 'new payload');
  const committed = record('developer', 'original payload');
  let creates = 0;
  await assert.rejects(
    persistMemoryOnce(requested, async () => { creates += 1; }, async () => committed),
    /memory idempotency conflict/,
  );
  assert.equal(creates, 0);
});

test('persistMemoryOnce reconciles a duplicate-create race through exact readback', async () => {
  const committed = record();
  let reads = 0;
  const actual = await persistMemoryOnce(
    committed,
    async () => { throw new Error('409 conflict'); },
    async () => {
      reads += 1;
      return reads === 1 ? null : committed;
    },
  );
  assert.strictEqual(actual, committed);
  assert.equal(reads, 2, 'one pre-create read and one reconciliation read');
});

test('persistMemoryOnce returns committed record after create commits but acknowledgement times out', async () => {
  const committed = record();
  const stored = new Map<string, MemoryRecord>();
  let creates = 0;
  const create = async (value: MemoryRecord) => {
    creates += 1;
    stored.set(value.id, value);
    throw new Error('request timeout after commit');
  };
  const read = async (id: string) => stored.get(id) ?? null;
  const actual = await persistMemoryOnce(committed, create, read);
  assert.strictEqual(actual, committed);
  assert.equal(creates, 1);
});

test('persistMemoryOnce never returns a phantom receipt after a failed create', async () => {
  const requested = record();
  await assert.rejects(
    persistMemoryOnce(requested, async () => { throw new Error('storage unavailable'); }, async () => null),
    /storage unavailable/,
  );
});

test('persistMemoryOnce propagates a preflight read failure and never attempts create', async () => {
  const requested = record();
  let creates = 0;
  await assert.rejects(
    persistMemoryOnce(
      requested,
      async () => { creates += 1; },
      async () => { throw new Error('read unavailable'); },
    ),
    /read unavailable/,
  );
  assert.equal(creates, 0);
});

test('persistMemoryOnce surfaces a reconciliation read failure after an uncertain create', async () => {
  const requested = record();
  let reads = 0;
  await assert.rejects(
    persistMemoryOnce(
      requested,
      async () => { throw new Error('create acknowledgement lost'); },
      async () => {
        reads += 1;
        if (reads === 1) return null;
        throw new Error('reconciliation read unavailable');
      },
    ),
    /reconciliation read unavailable/,
  );
  assert.equal(reads, 2);
});

test('unkeyed legacy records retain append behavior and do not read before each create', async () => {
  const base = record();
  const legacy: MemoryRecord = { ...base, id: 'm_legacy_synthetic', idempotency: undefined };
  let creates = 0;
  let reads = 0;
  const create = async () => { creates += 1; };
  const read = async () => { reads += 1; return null; };
  await persistMemoryOnce(legacy, create, read);
  await persistMemoryOnce(legacy, create, read);
  assert.equal(creates, 2);
  assert.equal(reads, 0);
});
