import test from 'node:test';
import assert from 'node:assert/strict';
import type { DaytonaBinding } from './contract.js';
import type { DaytonaViewerGrantRecord, DaytonaViewerGrantStore } from './viewer-grant-store.js';

const organizationId = '501db94e-10ee-4bc8-9cca-23c793c67524';
const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const handle = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const module = await import('./viewer-expiry.js').catch(() => null);
  assert.equal(typeof module?.DaytonaViewerExpiryController, 'function', 'explicit private viewer expiry controller is missing');
  const metadata = await import('./viewer-grant-store.js'); let now = Date.now();
  const row: DaytonaViewerGrantRecord = { version: 2, organizationId, binding, grantHandle: handle, bindingHash: metadata.daytonaViewerGrantBindingHash(organizationId, binding), scopeHash: metadata.daytonaViewerPhysicalScopeHash(organizationId, binding.sandboxId), expiresAt: now + 60000, phase: 'ACTIVE', sealed: { iv: Buffer.alloc(12).toString('base64url'), tag: Buffer.alloc(16).toString('base64url'), ciphertext: Buffer.alloc(32).toString('base64url') } };
  const state = { scope: handle as string | null, row: structuredClone(row) as DaytonaViewerGrantRecord | null, reads: [] as string[], revokes: [] as Array<{ binding: DaytonaBinding; handle: string }>, fail: false, hang: false, scopeReads: 0 };
  const store: DaytonaViewerGrantStore = {
    reserve: async () => { throw new Error('watchdog cannot mint'); }, compareAndSwap: async () => { throw new Error('watchdog must use existing revoke protocol'); },
    readPhysicalScope: async scope => { state.scopeReads++; state.reads.push(scope); if (state.fail) throw new Error('secret-source-error'); return state.scope; },
    load: async id => { state.reads.push(id); return structuredClone(state.row); },
  };
  const revoke = async (owned: DaytonaBinding, id: string, signal?: AbortSignal) => {
    state.revokes.push({ binding: structuredClone(owned), handle: id }); assert.ok(signal);
    if (state.row) state.row.phase = 'REVOKING';
    if (state.hang) await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('private-signed-url-secret')), { once: true }));
    if (state.fail) throw new Error('private-signed-url-secret');
    state.scope = null; if (state.row) state.row.phase = 'REVOKED'; return { human_input_revoked: true as const };
  };
  const options = { store, port: { revoke }, organizationId, sandboxId: binding.sandboxId, deadlineMs: 25, now: () => now, freshnessMs: 1000 };
  const controller = new module!.DaytonaViewerExpiryController(options);
  return { controller, state, row, options, module: module!, setNow: (value: number) => { now = value; } };
}
test('watchdog construction and readiness are effect-free; exact physical scope reads need no scan/index', async () => {
  const { controller, state, row } = await fixture(); assert.equal(controller.ready(), false); assert.equal(state.reads.length, 0); assert.equal(state.revokes.length, 0);
  state.scope = null; assert.deepEqual(await controller.tick(), { status: 'idle' }); assert.equal(controller.ready(), true);
  assert.deepEqual(state.reads, [row.scopeHash]); assert.equal(state.revokes.length, 0);
});
test('unexpired ACTIVE original grant is observed only; overdue ACTIVE invokes exact owned full revoke once', async () => {
  const { controller, state, row, setNow } = await fixture();
  assert.deepEqual(await controller.tick(), { status: 'active' }); assert.equal(state.revokes.length, 0); assert.equal(controller.ready(), true);
  setNow(row.expiresAt); assert.deepEqual(await controller.tick(), { status: 'expired_revoked' });
  assert.deepEqual(state.revokes, [{ binding, handle }]); assert.equal(controller.ready(), true);
  assert.deepEqual(await controller.tick(), { status: 'idle' }); assert.equal(state.revokes.length, 1); assert.equal(row.expiresAt, state.row!.expiresAt);
});
test('MINTING/REVOKING ambiguity and historical REVOKED receipt with a live scope never replay provider operations', async () => {
  for (const phase of ['MINTING', 'REVOKING', 'REVOKED'] as const) {
    const { controller, state, row, setNow } = await fixture(); state.row!.phase = phase;
    if (phase !== 'REVOKING') delete state.row!.sealed; setNow(row.expiresAt + 1);
    assert.equal((await controller.tick()).status, 'operator_attention'); assert.equal(controller.ready(), false);
    await controller.tick(); assert.equal(state.revokes.length, 0); assert.equal(state.scope, handle);
  }
});
test('receipt binding/profile/principal/hash/organization/sandbox mismatch or missing metadata fail closed before effects', async () => {
  for (const corrupt of [(value: DaytonaViewerGrantRecord) => { value.binding.ownerSubjectHash = 'c'.repeat(64); }, (value: DaytonaViewerGrantRecord) => { value.bindingHash = 'c'.repeat(64); }, (value: DaytonaViewerGrantRecord) => { value.scopeHash = 'c'.repeat(64); }, (value: DaytonaViewerGrantRecord) => { value.organizationId = '22222222-2222-4222-8222-222222222222'; }, (value: DaytonaViewerGrantRecord) => { value.binding.sandboxId = 'other'; }, (value: DaytonaViewerGrantRecord) => { value.grantHandle = '22222222-2222-4222-8222-222222222222'; }]) {
    const { controller, state, row, setNow } = await fixture(); corrupt(state.row!); setNow(row.expiresAt + 1);
    assert.equal((await controller.tick()).status, 'operator_attention'); assert.equal(controller.ready(), false); assert.equal(state.revokes.length, 0);
  }
  const { controller, state } = await fixture(); state.row = null;
  assert.equal((await controller.tick()).status, 'operator_attention'); assert.equal(state.revokes.length, 0);
});
test('watchdog health expires without ticks and unknown storage never becomes a release receipt', async () => {
  const { controller, state, row, setNow } = await fixture(); state.scope = null; await controller.tick(); assert.equal(controller.ready(), true);
  setNow(row.expiresAt); assert.equal(controller.ready(), false); state.fail = true;
  const result = await controller.tick(); assert.equal(result.status, 'operator_attention'); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(controller.ready(), false);
});
test('one tick in flight, absolute cancellation and unknown revoke retain fence and require operator attention', async () => {
  const { controller, state, row, setNow } = await fixture(); setNow(row.expiresAt); state.hang = true;
  const first = controller.tick(); await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(await controller.tick(), { status: 'busy' });
  const outcome = await first; assert.equal(outcome.status, 'operator_attention'); assert.equal(state.scope, handle); assert.equal(controller.ready(), false);
  assert.equal(state.revokes.length, 1);
  assert.equal((await controller.tick()).status, 'operator_attention'); assert.equal(state.revokes.length, 1);
});
