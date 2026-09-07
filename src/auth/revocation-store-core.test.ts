import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken } from '../audit/logger.js';
import {
  TokenRevocationStore,
  type RevocationPersistence,
} from './revocation-store-core.js';

function fixture(options: ConstructorParameters<typeof TokenRevocationStore>[1] = {}) {
  let failRead = false;
  let failFirstAWrite = false;
  let rows: Record<string, unknown>[] = [];
  const persisted = new Map<string, Record<string, unknown>>();
  const persistence: RevocationPersistence = {
    isConfigured: () => true,
    query: async () => {
      if (failRead) throw new Error('fixture read failure');
      return rows;
    },
    upsert: async (hash, at, reason) => {
      if (failFirstAWrite && reason === 'first A') {
        failFirstAWrite = false;
        throw new Error('fixture write failure');
      }
      persisted.set(hash, { hash, revoked_at: at, revoked_reason: reason });
    },
  };
  return {
    store: new TokenRevocationStore(persistence, options),
    persisted,
    setRows(next: Record<string, unknown>[]) {
      rows = next;
    },
    setFailRead(next: boolean) {
      failRead = next;
    },
    failNextAWrite() {
      failFirstAWrite = true;
    },
  };
}

test('configured store fails closed before the initial durable read', () => {
  const { store } = fixture();
  assert.deepEqual(
    { ready: store.status().static_token_auth_ready, state: store.status().state },
    { ready: false, state: 'initializing' },
  );
});

test('failed initial read differs from a valid empty durable state', async () => {
  const f = fixture();
  f.setFailRead(true);
  assert.equal(await f.store.load(), 0);
  assert.equal(f.store.status().state, 'unavailable');
  assert.equal(f.store.status().static_token_auth_ready, false);

  f.setFailRead(false);
  f.setRows([]);
  assert.equal(await f.store.load(), 0);
  assert.equal(f.store.status().state, 'ready');
  assert.equal(f.store.status().static_token_auth_ready, true);
});

test('persistence failure is reported and retains the immediate local deny', async () => {
  const f = fixture();
  await f.store.load();
  f.failNextAWrite();
  const result = await f.store.revoke('fixture-token-A', 'first A');
  assert.equal(result.durability, 'failed');
  assert.equal(result.persisted, false);
  assert.equal(f.store.isRevoked('fixture-token-A'), true);
  assert.equal(f.persisted.size, 0);
});

test('retry and concurrent revoke preserve every existing revocation', async () => {
  const f = fixture();
  await f.store.load();
  f.failNextAWrite();
  const [a, b] = await Promise.all([
    f.store.revoke('fixture-token-A', 'first A'),
    f.store.revoke('fixture-token-B', 'first B'),
  ]);
  assert.equal(a.durability, 'failed');
  assert.equal(b.durability, 'durable');
  assert.equal(a.revoked_token_hash, hashToken('fixture-token-A'));
  assert.equal(b.revoked_token_hash, hashToken('fixture-token-B'));
  assert.equal(f.store.isRevoked('fixture-token-A'), true);
  assert.equal(f.store.isRevoked('fixture-token-B'), true);

  const retry = await f.store.revoke('fixture-token-A', 'retry A');
  assert.equal(retry.durability, 'durable');
  assert.equal(f.persisted.has(hashToken('fixture-token-A')), true);
  assert.equal(f.persisted.has(hashToken('fixture-token-B')), true);
});

test('reload failure after readiness uses an explicit stale deny-set', async () => {
  let now = Date.parse('2026-09-07T00:00:00.000Z');
  const f = fixture({ now: () => now, maxStaleMs: 300_000 });
  const token = 'fixture-token-A';
  f.setRows([{
    hash: hashToken(token),
    revoked_at: '2026-09-07T00:00:00.000Z',
    revoked_reason: 'fixture',
  }]);
  await f.store.load();
  f.setFailRead(true);
  now += 299_999;
  await f.store.load();
  assert.equal(f.store.status().state, 'stale');
  assert.equal(f.store.status().static_token_auth_ready, true);
  assert.equal(f.store.isRevoked(token), true);

  now += 1;
  assert.equal(f.store.status().state, 'stale_expired');
  assert.equal(f.store.status().static_token_auth_ready, false);
  assert.equal(f.store.status().stale_for_ms, 300_000);
  assert.equal(f.store.isRevoked(token), true, 'known revocations remain locally denied after expiry');
});

test('snapshot freshness expires at MAX_STALE even when the reload timer never runs', async () => {
  const started = Date.parse('2026-09-07T00:00:00.000Z');
  let now = started;
  const f = fixture({ now: () => now, maxStaleMs: 300_000 });
  await f.store.load();

  now = started + 30_000;
  assert.equal(f.store.status().state, 'ready', 'the normal 30s reload cadence is inside the window');
  assert.equal(f.store.status().stale_for_ms, null);

  now = started + 299_999;
  assert.equal(f.store.status().state, 'ready');
  assert.equal(f.store.status().static_token_auth_ready, true);

  now = started + 300_000;
  assert.equal(f.store.status().state, 'stale_expired');
  assert.equal(f.store.status().static_token_auth_ready, false);
  assert.equal(f.store.status().stale_for_ms, 300_000);
  assert.equal(f.store.status().last_failed_load_at, null, 'timer absence is not fabricated as a failed query');
});

test('a pending reload cannot keep an old successful snapshot ready forever', async () => {
  const started = Date.parse('2026-09-07T00:00:00.000Z');
  let now = started;
  let calls = 0;
  let finishPending: (() => void) | undefined;
  const persistence: RevocationPersistence = {
    isConfigured: () => true,
    query: async () => {
      calls += 1;
      if (calls === 1) return [];
      await new Promise<void>((resolve) => {
        finishPending = resolve;
      });
      return [];
    },
    upsert: async () => undefined,
  };
  const store = new TokenRevocationStore(persistence, { now: () => now, maxStaleMs: 300_000 });
  await store.load();

  now = started + 30_000;
  const pending = store.load();
  await Promise.resolve();
  assert.equal(store.status().state, 'ready');
  assert.equal(store.status().last_failed_load_at, null);

  now = started + 300_000;
  assert.equal(store.status().state, 'stale_expired');
  assert.equal(store.status().static_token_auth_ready, false);
  assert.equal(store.status().stale_for_ms, 300_000);

  finishPending?.();
  await pending;
  assert.equal(store.status().state, 'ready', 'a later complete refresh starts a new freshness window');
  assert.equal(store.status().static_token_auth_ready, true);
});

test('MAX_STALE zero expires a completed durable snapshot at the exact boundary', async () => {
  let now = Date.parse('2026-09-07T00:00:00.000Z');
  const f = fixture({ now: () => now, maxStaleMs: 0 });
  await f.store.load();
  assert.equal(f.store.status().state, 'stale_expired');
  assert.equal(f.store.status().static_token_auth_ready, false);
  assert.equal(f.store.status().stale_for_ms, 0);
});

test('missing persistence fails closed unless memory mode is explicitly enabled', async () => {
  const persistence: RevocationPersistence = {
    isConfigured: () => false,
    query: async () => [],
    upsert: async () => undefined,
  };
  const production = new TokenRevocationStore(persistence);
  assert.equal(production.status().state, 'unavailable');
  assert.equal(production.status().static_token_auth_ready, false);
  assert.equal((await production.revoke('fixture-token', 'fixture')).durability, 'failed');

  const development = new TokenRevocationStore(persistence, { allowMemoryOnly: true });
  assert.equal(development.status().state, 'memory_only');
  assert.equal(development.status().static_token_auth_ready, true);
  assert.equal((await development.revoke('fixture-token', 'fixture')).durability, 'memory_only');
});

test('oversized or malformed loads never mark the store ready or partially mutate it', async () => {
  const oversized = fixture({ maxRows: 1 });
  oversized.setRows([
    { hash: hashToken('A'), revoked_at: '2026-09-07T00:00:00.000Z' },
    { hash: hashToken('B'), revoked_at: '2026-09-07T00:00:01.000Z' },
  ]);
  await oversized.store.load();
  assert.equal(oversized.store.status().state, 'unavailable');
  assert.equal(oversized.store.isRevoked('A'), false);

  const malformed = fixture();
  malformed.setRows([
    { hash: hashToken('valid'), revoked_at: '2026-09-07T00:00:00.000Z' },
    { hash: 'not-a-hash', revoked_at: 'not-a-date' },
  ]);
  await malformed.store.load();
  assert.equal(malformed.store.status().state, 'unavailable');
  assert.equal(malformed.store.isRevoked('valid'), false);
});

test('durable clear is refused without removing local denies', async () => {
  const f = fixture();
  await f.store.load();
  await f.store.revoke('fixture-token', 'fixture');
  const result = await f.store.clear();
  assert.equal(result.status, 'durable_clear_disabled');
  assert.equal(result.cleared, false);
  assert.equal(result.local_revocations_preserved, true);
  assert.equal(f.store.isRevoked('fixture-token'), true);
});

