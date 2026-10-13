import assert from 'node:assert/strict';
import test from 'node:test';
import type { CloudBrowserProfile, CloudBrowserSession, CloudBrowserStore, CloudBrowserTransport } from './contract.js';
import { cleanupExpiredBrowserSession } from './session-recovery.js';

const session: CloudBrowserSession = {
  sessionId: 'session-1', owner: 'cto', profileId: 'profile-1', allowedHosts: ['example.com'],
  expiresAt: 100, actionsUsed: 2, providerSessionId: 'provider-session', providerBrowserId: 'browser-resource',
  automationEndpoint: 'wss://provider.example/session', ownedTargetIds: ['owned-target'], selectedTargetId: 'owned-target',
};
const profile: CloudBrowserProfile = { profileId: 'profile-1', owner: 'cto', allowedHosts: ['example.com'], persistent: false };

function harness() {
  const calls: string[] = [];
  let lock: string | null = null;
  const store = {
    async loadSession(id: string) { calls.push(`load:${id}`); return id === session.sessionId ? session : null; },
    async loadProfile(id: string) { calls.push(`profile:${id}`); return id === profile.profileId ? profile : null; },
    async claimExpiredSessionCleanup(id: string, owner: string, now: number, token: string) {
      calls.push(`claim:${id}:${owner}:${now}`);
      if (id !== session.sessionId || owner !== session.owner || session.expiresAt > now || lock) return false;
      lock = token; return true;
    },
    async deleteExpiredSessionUnderLock(id: string, owner: string, token: string, now: number) {
      calls.push(`delete:${id}:${owner}:${now}`);
      return id === session.sessionId && owner === session.owner && lock === token && session.expiresAt <= now;
    },
    async releaseSessionLock(id: string, token: string) { calls.push(`release:${id}`); if (lock === token) lock = null; },
  } as unknown as CloudBrowserStore & {
    claimExpiredSessionCleanup(id: string, owner: string, now: number, token: string): Promise<boolean>;
    deleteExpiredSessionUnderLock(id: string, owner: string, token: string, now: number): Promise<boolean>;
  };
  const stopped: CloudBrowserSession[] = [];
  const transport = { async stop(value: CloudBrowserSession) { stopped.push(value); } } as CloudBrowserTransport;
  return { store, transport, calls, stopped };
}

test('expired-session recovery stops the complete owner-verified durable session under a lock', async () => {
  const h = harness();
  const result = await cleanupExpiredBrowserSession({ store: h.store, transport: h.transport, sessionId: session.sessionId, owner: session.owner, now: 101 });
  assert.equal(result, 'stopped');
  assert.deepEqual(h.stopped, [session]);
  assert.ok(h.calls.includes('claim:session-1:cto:101'));
  assert.ok(h.calls.includes('delete:session-1:cto:101'));
  assert.ok(h.calls.includes('release:session-1'));
});

test('owner mismatch, missing profile, unexpired session, and busy lock never stop the provider session', async () => {
  for (const scenario of ['owner mismatch', 'missing profile', 'unexpired', 'busy lock']) {
    const h = harness();
    if (scenario === 'owner mismatch') {
      const originalLoad = h.store.loadSession.bind(h.store);
      h.store.loadSession = async (id: string) => ({ ...await originalLoad(id)!, owner: 'other' });
    } else if (scenario === 'unexpired') {
      const originalLoad = h.store.loadSession.bind(h.store);
      h.store.loadSession = async (id: string) => ({ ...await originalLoad(id)!, expiresAt: 102 });
    } else if (scenario === 'missing profile') {
      h.store.loadProfile = async () => null;
    } else {
      h.store.claimExpiredSessionCleanup = async () => false;
    }
    const result = await cleanupExpiredBrowserSession({ store: h.store, transport: h.transport, sessionId: session.sessionId, owner: 'cto', now: 101 });
    assert.notEqual(result, 'stopped');
    assert.equal(h.stopped.length, 0);
  }
});
