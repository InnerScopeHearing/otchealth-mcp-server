import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DaytonaViewerGrantRecord } from './viewer-grant-store.js';
import { daytonaViewerGrantBindingHash, daytonaViewerPhysicalScopeHash } from './viewer-grant-store.js';
import type { DaytonaBinding } from './contract.js';

const grantHandle = '11111111-1111-4111-8111-111111111111';
const organizationId = '501db94e-10ee-4bc8-9cca-23c793c67524';
const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const original: DaytonaViewerGrantRecord = { version: 2, organizationId, binding, grantHandle, bindingHash: daytonaViewerGrantBindingHash(organizationId, binding), scopeHash: daytonaViewerPhysicalScopeHash(organizationId, binding.sandboxId), expiresAt: 2000000000000, phase: 'MINTING' };
const active: DaytonaViewerGrantRecord = { ...original, phase: 'ACTIVE', sealed: { iv: Buffer.alloc(12, 1).toString('base64url'), tag: Buffer.alloc(16, 2).toString('base64url'), ciphertext: Buffer.alloc(100, 3).toString('base64url') } };
async function fixture() {
  const module = await import('./viewer-grant-store.js').catch(() => null);
  assert.equal(typeof module?.DynamoDaytonaViewerGrantStore, 'function', 'durable private viewer grant store is missing');
  const requests: Array<{ operation: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const state = { status: 200, result: {} as Record<string, unknown>, calls: 0 };
  const fetchImpl: typeof fetch = async (_url, init = {}) => {
    state.calls++;
    requests.push({ operation: new Headers(init.headers).get('x-amz-target')!.split('.').at(-1)!, body: JSON.parse(String(init.body)), init });
    return Response.json(state.result, { status: state.status });
  };
  const store = new module!.DynamoDaytonaViewerGrantStore({ tableName: 'private-grants', region: 'us-east-1', resolveCredentials: async () => ({ accessKeyId: 'test-key', secretAccessKey: 'test-secret' }), fetchImpl, now: () => 1000000000000 });
  return { module: module!, store, requests, state };
}
test('reserve atomically creates permanent physical scope fence and encrypted grant intent before effects', async () => {
  const { store, requests } = await fixture(); assert.equal(await store.reserve(original, AbortSignal.timeout(1000)), true);
  const call = requests[0]!; assert.equal(call.operation, 'TransactWriteItems');
  const writes = call.body.TransactItems as Array<{ Put: Record<string, unknown> }>;
  assert.equal(writes.length, 2);
  for (const write of writes) assert.equal(write.Put.ConditionExpression, 'attribute_not_exists(pk)');
  const serialized = JSON.stringify(call.body); assert.equal(serialized.includes('expiresAtEpoch'), false); assert.equal(serialized.includes('DAYTONA#VIEWER_GRANT#'), true); assert.equal(serialized.includes('DAYTONA#VIEWER_SCOPE#'), true);
  assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal);
});
test('load uses strong consistency and rejects unexpected or plaintext grant payloads', async () => {
  const { store, requests, state } = await fixture();
  state.result = { Item: { pk: { S: `DAYTONA#VIEWER_GRANT#${grantHandle}` }, payload: { S: JSON.stringify(active) } } };
  assert.deepEqual(await store.load(grantHandle, AbortSignal.timeout(1000)), active);
  assert.equal(requests[0]!.body.ConsistentRead, true);
  state.result = { Item: { pk: { S: `DAYTONA#VIEWER_GRANT#${grantHandle}` }, payload: { S: JSON.stringify({ ...active, token: 'forbidden-plaintext' }) } } };
  await assert.rejects(store.load(grantHandle, AbortSignal.timeout(1000)));
});
test('phase transitions use full original receipt CAS, never refresh original expiry, retain unknown records without TTL', async () => {
  const { store, requests } = await fixture();
  assert.equal(await store.compareAndSwap(original, active, AbortSignal.timeout(1000)), true);
  const request = requests[0]!; assert.equal(request.operation, 'UpdateItem');
  assert.equal(request.body.ConditionExpression, 'payload = :expected');
  assert.equal(JSON.stringify(request.body).includes('expiresAtEpoch'), false);
  await assert.rejects(store.compareAndSwap(active, { ...active, expiresAt: active.expiresAt + 1 }, AbortSignal.timeout(1000)));
  await assert.rejects(store.compareAndSwap(active, { ...active, phase: 'MINTING' }, AbortSignal.timeout(1000)));
  assert.equal(requests.length, 1);
});
test('only confirmed terminal revoke atomically removes exact owned scope fence and encrypted material', async () => {
  const { store, requests } = await fixture(); const revoking = { ...active, phase: 'REVOKING' as const };
  const revoked: DaytonaViewerGrantRecord = { ...original, phase: 'REVOKED' };
  assert.equal(await store.compareAndSwap(revoking, revoked, AbortSignal.timeout(1000)), true);
  const request = requests[0]!; assert.equal(request.operation, 'TransactWriteItems');
  const writes = request.body.TransactItems as Array<Record<string, Record<string, unknown>>>;
  assert.equal(writes[0]!.Update!.ConditionExpression, 'payload = :expected');
  assert.equal(writes[1]!.Delete!.ConditionExpression, 'grantHandle = :handle');
  assert.equal(JSON.stringify(writes[0]!.Update!.ExpressionAttributeValues).includes('ciphertext'), true, 'expected CAS still binds prior encrypted receipt');
  assert.equal(JSON.stringify(request.body).includes('expiresAtEpoch'), true);
});
test('conditional conflicts are finite false, unknown transaction outcomes throw sanitized error and are never retried', async () => {
  const { store, state } = await fixture(); state.status = 400;
  state.result = { __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] };
  assert.equal(await store.reserve(original, AbortSignal.timeout(1000)), false); assert.equal(state.calls, 1);
  state.result = { __type: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] };
  await assert.rejects(store.reserve(original, AbortSignal.timeout(1000)), e => !String(e).includes('TransactionConflict')); assert.equal(state.calls, 2);
  state.result = { __type: 'ConditionalCheckFailedException' };
  assert.equal(await store.compareAndSwap(original, active, AbortSignal.timeout(1000)), false); assert.equal(state.calls, 3);
});
test('physical scope lookup is strongly consistent, namespace-exact and rejects missing owners or TTL-reclaimable fences', async () => {
  const { store, requests, state } = await fixture(); const pk = `DAYTONA#VIEWER_SCOPE#${original.scopeHash}`;
  state.result = { Item: { pk: { S: pk }, grantHandle: { S: grantHandle } } };
  assert.equal(await store.readPhysicalScope(original.scopeHash, AbortSignal.timeout(1000)), grantHandle);
  assert.equal(requests[0]!.operation, 'GetItem'); assert.equal(requests[0]!.body.ConsistentRead, true);
  state.result = { Item: { pk: { S: pk }, grantHandle: { S: grantHandle }, expiresAtEpoch: { N: '1' } } };
  await assert.rejects(store.readPhysicalScope(original.scopeHash, AbortSignal.timeout(1000)));
  state.result = { Item: { pk: { S: pk } } }; await assert.rejects(store.readPhysicalScope(original.scopeHash, AbortSignal.timeout(1000)));
});
test('v2 restart ownership metadata is strict, hash-bound and never accepts credential-bearing extra fields', async () => {
  const { store, state } = await fixture();
  for (const bad of [{ ...active, version: 1 }, { ...active, binding: { ...binding, apiToken: 'secret' } }, { ...active, binding: { ...binding, ownerSubjectHash: 'c'.repeat(64) } }, { ...active, organizationId: '22222222-2222-4222-8222-222222222222' }]) {
    state.result = { Item: { pk: { S: `DAYTONA#VIEWER_GRANT#${grantHandle}` }, payload: { S: JSON.stringify(bad) } } };
    await assert.rejects(store.load(grantHandle, AbortSignal.timeout(1000)));
  }
});
test('shared physical enrollment is hash-bound while legacy isolated binding hashes stay byte-compatible', async () => {
  const legacyParts = ['daytona-viewer-v1', organizationId, binding.owner, binding.ownerSubjectHash, binding.sandboxId, binding.profileKey, binding.profilePath, binding.readinessReceiptSha256];
  assert.equal(daytonaViewerGrantBindingHash(organizationId, binding), createHash('sha256').update(JSON.stringify(legacyParts)).digest('hex'));
  const shared: DaytonaBinding = { ...binding, profileKey: `cto-${binding.ownerSubjectHash}`, sharedProfileKey: 'company-browser', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium' };
  const sharedParts = ['daytona-viewer-v1', organizationId, shared.owner, shared.ownerSubjectHash, shared.sandboxId, shared.profileKey, shared.profilePath, shared.readinessReceiptSha256];
  const expected = createHash('sha256').update(JSON.stringify([...sharedParts, 'company-browser'])).digest('hex');
  assert.equal(daytonaViewerGrantBindingHash(organizationId, shared), expected);
  const { store, state } = await fixture();
  const record = { ...active, binding: shared, bindingHash: expected };
  state.result = { Item: { pk: { S: `DAYTONA#VIEWER_GRANT#${grantHandle}` }, payload: { S: JSON.stringify(record) } } };
  assert.deepEqual(await store.load(grantHandle, AbortSignal.timeout(1000)), record);
  const { sharedProfileKey: _shared, ...withoutMembership } = shared;
  for (const tampered of [{ ...record, binding: withoutMembership }, { ...record, bindingHash: createHash('sha256').update(JSON.stringify(sharedParts)).digest('hex') }]) {
    state.result = { Item: { pk: { S: `DAYTONA#VIEWER_GRANT#${grantHandle}` }, payload: { S: JSON.stringify(tampered) } } };
    await assert.rejects(store.load(grantHandle, AbortSignal.timeout(1000)));
  }
});
