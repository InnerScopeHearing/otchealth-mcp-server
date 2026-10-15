import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDaytonaBrowserStore } from './store.js';
import type { DaytonaBinding } from './contract.js';

const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
function fixture() {
  const calls: Array<Record<string, any>> = []; let conflict = false; let item: Record<string, any> | undefined;
  const store = new DynamoDaytonaBrowserStore({ tableName: 'test-browser-table', region: 'us-east-1', now: () => 1000,
    resolveCredentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic-secret' }),
    fetchImpl: async (_url, init) => { const data = JSON.parse(String(init?.body)); calls.push(data); if (conflict) return new Response(JSON.stringify({ __type: 'ConditionalCheckFailedException' }), { status: 400 }); if (data.Item) item = data.Item; return new Response(JSON.stringify(data.ConsistentRead ? { Item: item } : {})); },
  });
  return { store, calls, conflict: () => { conflict = true; } };
}
test('Daytona enrollment is immutable, provider-specific, credential-free and strongly consistent', async () => {
  const h = fixture(); assert.equal(await h.store.createBinding(binding), true);
  assert.equal(h.calls[0]!.Item.pk.S, 'DAYTONA#PROFILE#profile-one');
  assert.equal(h.calls[0]!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.deepEqual(await h.store.loadBinding('profile-one'), binding);
  assert.equal(h.calls[1]!.ConsistentRead, true);
  h.conflict(); assert.equal(await h.store.createBinding(binding), false);
});
test('Daytona binding rejects traversal, wrong profile paths and secret-bearing extra fields before AWS', async () => {
  const h = fixture();
  for (const value of [{ ...binding, profilePath: '/home/otcbrowser/.local/share/otchealth-browser/other/chromium' }, { ...binding, profileKey: '../other' }, { ...binding, token: 'private' }, { ...binding, owner: 123 }, { ...binding, readinessReceiptSha256: '' }]) await assert.rejects(h.store.createBinding(value as DaytonaBinding));
  assert.equal(h.calls.length, 0);
});
test('profile and session locks use exact owner conditions and never overwrite successor state', async () => {
  const h = fixture();
  assert.equal(await h.store.acquireProfileLease('profile-one', 'mission-one', 5000), true);
  assert.match(h.calls[0]!.ConditionExpression, /lockUntil < :now/);
  await h.store.releaseProfileLease('profile-one', 'mission-one');
  assert.equal(h.calls[1]!.ConditionExpression, 'lockOwner = :owner');
  assert.equal(h.calls[1]!.Key.pk.S, 'DAYTONA#LEASE#profile-one');
  h.conflict(); assert.equal(await h.store.acquireSessionLock('mission-one', 'lock-one', 5000), false);
  assert.doesNotMatch(h.calls[2]!.UpdateExpression, /expiresAtEpoch/, 'a short action lock must never shorten the mission TTL');
});
test('the maximum eight-hour logical mission can retain its bounded five-minute cleanup grace', async () => {
  const h = fixture(); assert.equal(await h.store.acquireProfileLease('profile-one', 'mission-one', 1000 + 28_800_000 + 300_000), true);
  await assert.rejects(h.store.acquireProfileLease('profile-one', 'mission-one', 1000 + 28_800_000 + 300_001));
});
