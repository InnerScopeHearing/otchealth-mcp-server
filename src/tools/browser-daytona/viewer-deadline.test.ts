import test from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaBrowserService } from './service.js';
import { EncryptedDaytonaViewerGrantPort } from './viewer-grants.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaBrowserStore, type DaytonaMission, type DaytonaProvider } from './contract.js';
import type { DaytonaViewerGrantRecord, DaytonaViewerGrantStore } from './viewer-grant-store.js';

const principal = 'a'.repeat(64), organizationId = '11111111-1111-4111-8111-111111111111';
const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: principal, sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
function fixture() {
  let now = 1000;
  const state = { storageDelay: 2000, inspectDelay: 500, reserveDelay: 0, readDelay: 0, badReceipt: false, foreignHandle: false, lostMintAck: false, minted: 0, revoked: 0, ttl: 0, expired: false };
  const sessions = new Map<string, DaytonaMission>(), leases = new Map<string, string>(), locks = new Map<string, string>(), rows = new Map<string, DaytonaViewerGrantRecord>();
  const store: DaytonaBrowserStore = {
    loadBinding: async () => ({ ...binding }), createBinding: async () => false,
    loadSession: async id => sessions.has(id) ? { ...sessions.get(id)! } : null,
    createSession: async s => { sessions.set(s.sessionId, { ...s }); return true; },
    saveSessionUnderLock: async s => { sessions.set(s.sessionId, { ...s }); if (s.sensitiveOutputSuppressed && !s.viewerGrantHandle) { now += state.storageDelay; state.storageDelay = 0; } },
    acquireSessionLock: async (id, key) => { if (locks.has(id)) return false; locks.set(id, key); return true; }, releaseSessionLock: async id => { locks.delete(id); },
    acquireProfileLease: async (key, id) => { if (leases.has(key)) return false; leases.set(key, id); return true; }, ownsProfileLease: async (key, id) => leases.get(key) === id,
    releaseProfileLease: async (key, id) => { if (leases.get(key) === id) leases.delete(key); },
  };
  const grants: DaytonaViewerGrantStore = {
    reserve: async value => { rows.set(value.grantHandle, structuredClone(value)); now += state.reserveDelay; return true; },
    load: async handle => structuredClone(rows.get(handle) ?? null), readPhysicalScope: async () => null,
    compareAndSwap: async (_before, after) => { rows.set(after.grantHandle, structuredClone(after)); return true; },
  };
  const port = new EncryptedDaytonaViewerGrantPort({ store: grants, apiBaseUrl: 'https://app.daytona.test/api', organizationId, resolveApiToken: async () => 'synthetic-only', encryptionKey: Uint8Array.from({ length: 32 }, (_, i) => i), previewDomain: 'proxy.daytona.test', previewPort: 6080, previewPath: '/vnc.html', viewerControlSha256: 'c'.repeat(64), toolboxAllowedOrigins: ['https://toolbox.daytona.test'], now: () => now,
    fetchImpl: async input => {
      const url = new URL(String(input));
      if (url.hostname.startsWith('6080-')) return new Response('', { status: state.expired ? 403 : 200 });
      if (url.pathname.endsWith('/expire')) { state.expired = true; state.revoked++; return new Response('', { status: 200 }); }
      if (url.pathname.endsWith('/signed-preview-url')) { state.minted++; state.ttl = Number(url.searchParams.get('expiresInSeconds')); return Response.json({ sandboxId: binding.sandboxId, port: 6080, token: 'synthetic', url: 'https://6080-synthetic.proxy.daytona.test/' }); }
      if (url.pathname.endsWith('/toolbox-proxy-url')) return Response.json({ url: 'https://toolbox.daytona.test/toolbox' });
      if (url.pathname.endsWith('/process/execute')) return Response.json({ exitCode: 0, result: JSON.stringify({ human_input_revoked: true, display: ':0', active_clients: 0, x11vnc_pid: 123 }) });
      now += state.inspectDelay;
      return Response.json({ id: binding.sandboxId, organizationId, public: false, state: 'started' });
    },
  });
  const provider: DaytonaProvider = { inspect: async () => ({ sandboxId: binding.sandboxId, state: 'started', public: false }), openMission: async () => {}, releaseMission: async () => {}, checkpoint: async () => {}, execute: async () => ({}),
    viewerGrant: async (b, seconds, notAfter) => { const grant = await port.mint(b, seconds, notAfter); if (state.lostMintAck) throw new Error('unknown mint acknowledgment'); return state.foreignHandle ? { ...grant, grantHandle: '22222222-2222-4222-8222-222222222222' } : state.badReceipt ? { ...grant, expiresAt: grant.expiresAt + 100000 } : grant; },
    readViewerGrant: (b, handle) => { now += state.readDelay; state.readDelay = 0; return port.read(b, handle); }, revokeViewerGrant: (b, handle) => port.revoke(b, handle),
  };
  return { service: new DaytonaBrowserService(store, provider, () => now), port, state, sessions, leases, rows, advance: (ms: number) => { now += ms; }, now: () => now };
}
test('actual service and encrypted vault keep a delayed near-expiry grant within its absolute mission deadline', async () => {
  const h = fixture(), session = await h.service.start('cto', binding.profileKey, 60, 5, principal);
  const grant = await h.service.getViewerGrant('cto', session.sessionId, principal, 60);
  assert.ok(grant.expiresAt <= session.expiresAt); assert.equal(h.state.ttl, 57); assert.equal(h.state.minted, 1);
  assert.equal(h.sessions.get(session.sessionId)!.viewerGrantHandle, grant.grantHandle);
  await h.service.stop('cto', session.sessionId, principal); assert.equal(h.leases.size, 0);
});
test('absolute deadline is rechecked after inspect and reservation before an effectful provider mint', async () => {
  for (const delay of ['inspect', 'reserve']) {
    const h = fixture(); h.state.storageDelay = 0; h.state.inspectDelay = delay === 'inspect' ? 1500 : 0; h.state.reserveDelay = delay === 'reserve' ? 1500 : 0;
    await assert.rejects(h.port.mint(binding, 60, h.now() + 1000));
    assert.equal(h.state.minted, 0);
  }
});
test('a known owned handle is durable before a bad post-mint receipt and remains stoppable after fenced cleanup', async () => {
  const h = fixture(); h.state.badReceipt = true;
  const session = await h.service.start('cto', binding.profileKey, 180, 5, principal);
  await assert.rejects(h.service.getViewerGrant('cto', session.sessionId, principal, 60));
  assert.ok(h.sessions.get(session.sessionId)!.viewerGrantHandle); assert.equal(h.sessions.get(session.sessionId)!.effectUnknown, true);
  assert.equal(h.state.revoked, 1); await h.service.stop('cto', session.sessionId, principal); assert.equal(h.leases.size, 0);
});
test('foreign handles and lost mint acknowledgments never become trusted session handles or clear fences', async () => {
  for (const failure of ['foreignHandle', 'lostMintAck'] as const) {
    const h = fixture(); h.state[failure] = true; const session = await h.service.start('cto', binding.profileKey, 180, 5, principal);
    await assert.rejects(h.service.getViewerGrant('cto', session.sessionId, principal, 60));
    assert.equal(h.sessions.get(session.sessionId)!.viewerGrantHandle, undefined); assert.equal(h.sessions.get(session.sessionId)!.effectUnknown, true);
    await assert.rejects(h.service.stop('cto', session.sessionId, principal), error => error instanceof DaytonaBrowserError && error.code === 'viewer_revocation_unknown');
    assert.equal(h.leases.size, 2);
  }
});
test('expiry during ownership read retains only a positively revoked owned handle for stop', async () => {
  const h = fixture(); h.state.readDelay = 61000;
  const session = await h.service.start('cto', binding.profileKey, 180, 5, principal);
  await assert.rejects(h.service.getViewerGrant('cto', session.sessionId, principal, 60));
  assert.equal(h.state.revoked, 1); assert.ok(h.sessions.get(session.sessionId)!.viewerGrantHandle);
  assert.equal(h.sessions.get(session.sessionId)!.effectUnknown, true);
  await h.service.stop('cto', session.sessionId, principal); assert.equal(h.leases.size, 0);
});
