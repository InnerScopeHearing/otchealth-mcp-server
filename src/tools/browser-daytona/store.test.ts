import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertDaytonaMission, DynamoDaytonaBrowserStore } from './store.js';
import type { DaytonaBinding, DaytonaMission } from './contract.js';

const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const sharedBinding = { ...binding, profileKey: `cto-${binding.ownerSubjectHash}`, sharedProfileKey: 'company-browser' as const, profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium' };
function fixture() {
  const calls: Array<Record<string, any>> = []; let conflict = false; let item: Record<string, any> | undefined;
  const store = new DynamoDaytonaBrowserStore({ tableName: 'test-browser-table', region: 'us-east-1', now: () => 1000,
    resolveCredentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic-secret' }),
    fetchImpl: async (_url, init) => { const data = JSON.parse(String(init?.body)); calls.push(data); if (conflict) return new Response(JSON.stringify({ __type: 'ConditionalCheckFailedException' }), { status: 400 }); if (data.Item) item = data.Item; return new Response(JSON.stringify(data.ConsistentRead ? { Item: item } : {})); },
  });
  return { store, calls, seed: (value: Record<string, any>) => { item = value; }, conflict: () => { conflict = true; } };
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
  assert.equal(h.calls[0]!.ConditionExpression, 'attribute_not_exists(lockOwner)', 'always-on input fences are never reclaimed solely by time');
  assert.equal(h.calls[0]!.ExpressionAttributeValues[':ttl'], undefined);
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
test('unclosed mission receipts and exact desktop fences survive logical expiry until positive cleanup', async () => {
  const h = fixture();
  const mission: DaytonaMission = { provider: 'daytona', sessionId: 'mission-one', owner: 'cto', ownerSubjectHash: binding.ownerSubjectHash, profileKey: binding.profileKey, sandboxId: binding.sandboxId, expiresAt: 2000, actionsUsed: 0, actionBudget: 5, effectUnknown: true, phase: 'OPENING' };
  await h.store.createSession(mission);
  assert.equal(h.calls[0]!.Item.expiresAtEpoch, undefined, 'unknown input-control state must not disappear via TTL');
  h.seed({ pk: { S: 'DAYTONA#LEASE#profile-one' }, lockOwner: { S: 'mission-one' }, lockUntil: { N: '1' } });
  assert.equal(await h.store.ownsProfileLease('profile-one', 'mission-one'), true, 'expiry may block actions but cannot destroy exact-owner cleanup authority');
  assert.equal(await h.store.ownsProfileLease('profile-one', 'successor'), false);
});
test('explicit server-enrolled shared membership retains its immutable virtual identity and physical path', async () => {
  const h = fixture(); assert.equal(await h.store.createBinding(sharedBinding), true);
  assert.equal(h.calls[0]!.Item.pk.S, `DAYTONA#PROFILE#${sharedBinding.profileKey}`);
  assert.equal(h.calls[0]!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.deepEqual(await h.store.loadBinding(sharedBinding.profileKey), sharedBinding);
  h.conflict(); assert.equal(await h.store.createBinding(sharedBinding), false);
});
test('shared enrollment cannot forge its fixed physical key, member principal, virtual key or physical path', async () => {
  const h = fixture();
  for (const bad of [
    { ...sharedBinding, sharedProfileKey: 'other-browser' }, { ...sharedBinding, sharedProfileKey: undefined },
    { ...sharedBinding, sharedProfileKey: null }, { ...sharedBinding, profileKey: 'company-browser' },
    { ...sharedBinding, owner: 'cfo' }, { ...sharedBinding, ownerSubjectHash: 'c'.repeat(64) },
    { ...sharedBinding, profilePath: binding.profilePath }, { ...sharedBinding, apiToken: 'not-accepted' },
    { ...sharedBinding, profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/../other/chromium' },
  ]) await assert.rejects(h.store.createBinding(bad as DaytonaBinding));
  assert.equal(h.calls.length, 0);
  const isolated = { ...binding, profileKey: sharedBinding.profileKey, profilePath: sharedBinding.profilePath };
  await assert.rejects(h.store.createBinding(isolated));
  assert.equal(h.calls.length, 0, 'the shared path never silently enrolls an isolated binding');
});
test('V2 mission protocol is immutable receipt metadata and rejects unsupported or caller-shaped versions', () => {
  const mission: DaytonaMission = { provider: 'daytona', sessionId: 'mission-one', owner: 'cto', ownerSubjectHash: binding.ownerSubjectHash, profileKey: binding.profileKey, sandboxId: binding.sandboxId, expiresAt: 2000, actionsUsed: 0, actionBudget: 5, effectUnknown: false, phase: 'ACTIVE' };
  assert.doesNotThrow(() => assertDaytonaMission(mission));
  assert.doesNotThrow(() => assertDaytonaMission({ ...mission, runtimeProtocol: 2 }));
  for (const runtimeProtocol of [1, 3, '2', null, undefined, true]) assert.throws(() => assertDaytonaMission({ ...mission, runtimeProtocol }));
});

function migrationFixture() {
  const old = { ...sharedBinding, sandboxId: '11111111-1111-4111-8111-111111111111' };
  const next = { ...old, sandboxId: '22222222-2222-4222-8222-222222222222', readinessReceiptSha256: 'c'.repeat(64) };
  const guards = { organizationId: '33333333-3333-4333-8333-333333333333', viewerGrantTableName: 'test-viewer-table' };
  const raw = JSON.stringify(old, null, 2); const pk = `DAYTONA#PROFILE#${old.profileKey}`;
  const rows = new Map<string, any>([[`test-browser-table/${pk}`, { pk: { S: pk }, payload: { S: raw } }]]);
  const calls: any[] = []; let loseAck = false;
  const store = new DynamoDaytonaBrowserStore({ tableName: 'test-browser-table', region: 'us-east-1', resolveCredentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }), fetchImpl: async (_url, init) => {
    const data = JSON.parse(String(init?.body)); calls.push(data);
    if (data.ConsistentRead) return Response.json({ Item: rows.get(`${data.TableName}/${data.Key.pk.S}`) });
    const items = data.TransactItems as any[];
    const codes = items.map(item => { const value = item.Update ?? item.ConditionCheck, row = rows.get(`${value.TableName}/${value.Key.pk.S}`); return item.Update ? row?.payload?.S === value.ExpressionAttributeValues[':expected'].S : row === undefined; });
    if (codes.includes(false)) return Response.json({ __type: 'TransactionCanceledException', CancellationReasons: codes.map(ok => ({ Code: ok ? 'None' : 'ConditionalCheckFailed' })) }, { status: 400 });
    for (const item of items) if (item.Update) { const update = item.Update; rows.set(`${update.TableName}/${update.Key.pk.S}`, { pk: update.Key.pk, payload: update.ExpressionAttributeValues[':next'] }); }
    if (loseAck) throw new Error('unknown transaction acknowledgement');
    return Response.json({});
  } });
  return { store, old, next, guards, raw, pk, rows, calls, loseAck: () => { loseAck = true; } };
}
test('dedicated binding migration CAS uses exact stored raw bytes and atomically fences both physical desktops plus immutable profile lease', async () => {
  const h = migrationFixture();
  assert.equal(await h.store.migrateBinding(h.raw, h.next, h.guards), true);
  assert.deepEqual(JSON.parse(h.rows.get(`test-browser-table/${h.pk}`).payload.S), h.next);
  assert.equal(h.calls[0].ConsistentRead, true);
  const transaction = h.calls[1]; assert.equal(transaction.TableName, undefined); assert.equal(transaction.TransactItems.length, 6);
  const update = transaction.TransactItems[0].Update; assert.equal(update.ExpressionAttributeValues[':expected'].S, h.raw);
  for (const item of transaction.TransactItems.slice(1)) assert.equal(item.ConditionCheck.ConditionExpression, 'attribute_not_exists(pk)');
  const same = migrationFixture(); same.next.sandboxId = same.old.sandboxId;
  assert.equal(await same.store.migrateBinding(same.raw, same.next, same.guards), true);
  assert.equal(same.calls[1].TransactItems.length, 4, 'same physical desktop must not appear twice in one Dynamo transaction');
});
test('any old/new lease or viewer fence, changed full raw payload, and foreign migration identity refuses before changing binding', async () => {
  const base = migrationFixture();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const keys = [ `test-browser-table/DAYTONA#LEASE#${base.old.profileKey}`,
    ...[base.old.sandboxId, base.next.sandboxId].flatMap(sid => [`test-browser-table/DAYTONA#LEASE#display-${hash(sid).slice(0, 40)}`, `test-viewer-table/DAYTONA#VIEWER_SCOPE#${hash(JSON.stringify(['daytona-viewer-scope-v1', base.guards.organizationId, sid]))}`]) ];
  for (const key of keys) { const h = migrationFixture(); h.rows.set(key, { lockOwner: { S: 'active-or-unknown-owner' } }); assert.equal(await h.store.migrateBinding(h.raw, h.next, h.guards), false); assert.equal(h.rows.get(`test-browser-table/${h.pk}`).payload.S, h.raw); }
  const stale = migrationFixture(); assert.equal(await stale.store.migrateBinding(JSON.stringify(stale.old), stale.next, stale.guards), false); assert.equal(stale.calls.length, 1);
  for (const change of [{ owner: 'cfo' }, { profilePath: '/untrusted' }, { sharedProfileKey: undefined }, { ownerSubjectHash: 'd'.repeat(64) }, { token: 'not-accepted' }]) { const h = migrationFixture(); await assert.rejects(h.store.migrateBinding(h.raw, { ...h.next, ...change } as DaytonaBinding, h.guards)); assert.equal(h.calls.length, 0); }
});
test('unknown binding transaction acknowledgement is never retried or treated as an empty lease', async () => {
  const h = migrationFixture(); h.loseAck(); await assert.rejects(h.store.migrateBinding(h.raw, h.next, h.guards));
  assert.equal(h.calls.length, 2); assert.deepEqual(JSON.parse(h.rows.get(`test-browser-table/${h.pk}`).payload.S), h.next);
});
test('all seven binding migrations commit atomically in one deduplicated fleet transaction, never a partial sequence', async () => {
  const make = () => {
    const h = migrationFixture(); h.rows.clear();
    const entries = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'].map((owner, i) => {
      const principal = String(i + 1).repeat(64);
      const old = { ...h.old, owner, ownerSubjectHash: principal, profileKey: `${owner}-${principal}`, sandboxId: '99999999-9999-4999-8999-999999999999' };
      const next = { ...old, sandboxId: `${i + 1}1111111-1111-4111-8111-111111111111`, readinessReceiptSha256: 'e'.repeat(64) };
      const expectedRawPayload = JSON.stringify(old, null, 2), pk = `DAYTONA#PROFILE#${old.profileKey}`;
      h.rows.set(`test-browser-table/${pk}`, { pk: { S: pk }, payload: { S: expectedRawPayload } });
      return { expectedRawPayload, next };
    });
    return { ...h, entries };
  };
  const h = make(); assert.equal(await h.store.migrateBindings(h.entries, h.guards), true);
  const transactions = h.calls.filter(call => call.TransactItems); assert.equal(transactions.length, 1); assert.equal(transactions[0].TransactItems.length, 30);
  for (const entry of h.entries) assert.deepEqual(JSON.parse(h.rows.get(`test-browser-table/DAYTONA#PROFILE#${entry.next.profileKey}`).payload.S), entry.next);
  const blocked = make(); blocked.rows.set(`test-browser-table/DAYTONA#LEASE#${blocked.entries[6]!.next.profileKey}`, { lockOwner: { S: 'unknown' } });
  assert.equal(await blocked.store.migrateBindings(blocked.entries, blocked.guards), false);
  for (const entry of blocked.entries) assert.equal(blocked.rows.get(`test-browser-table/DAYTONA#PROFILE#${entry.next.profileKey}`).payload.S, entry.expectedRawPayload);
});
