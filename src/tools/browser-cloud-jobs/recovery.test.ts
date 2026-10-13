import assert from 'node:assert/strict';
import test from 'node:test';

const NOW = Date.parse('2026-10-13T16:50:00.000Z');

type BrowserPendingDispatch = { id: string; owner: string; version: number; status: 'pending'; effect: 'none' | 'unknown' | 'succeeded'; dueAt: number; attempts: number };
type BrowserExpiredSession = { id: string; owner: string; providerSessionId: string; ownership: 'confirmed' | 'unknown'; version: number; status: 'cleanup_pending'; expiresAt: number | null };
type BrowserRecoveryStore = {
  listPending(now: number, limit: number): Promise<BrowserPendingDispatch[]>;
  claimDispatch(id: string, version: number, until: number): Promise<string | null>;
  markDispatched(id: string, token: string): Promise<boolean>;
  markReconciliation(id: string, token: string): Promise<boolean>;
};
type BrowserExpiredSessionStore = {
  listExpired(now: number, limit: number): Promise<BrowserExpiredSession[]>;
  claimCleanup(id: string, version: number, until: number): Promise<string | null>;
  markStopped(id: string, token: string): Promise<boolean>;
  markCleanupFailed(id: string, token: string): Promise<boolean>;
};

async function optionalRecoveryModule() {
  try {
    return await import('./recovery.js');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND'
      && 'url' in error && typeof error.url === 'string' && error.url.endsWith('/src/tools/browser-cloud-jobs/recovery.js')) return undefined;
    throw error;
  }
}

function recoveryHarness(seed: BrowserPendingDispatch[]) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  let nextFence = 0;
  const leases = new Map<string, { token: string; until: number }>();
  const queryLimits: number[] = [];
  const store: BrowserRecoveryStore = {
    async listPending(now, limit) {
      queryLimits.push(limit);
      return [...rows.values()].filter((r) => r.status === 'pending' && r.dueAt <= now).slice(0, limit).map((r) => structuredClone(r));
    },
    async claimDispatch(id, version, until) {
      const row = rows.get(id);
      if (!row || row.version !== version || row.status !== 'pending' || leases.has(id)) return null;
      const token = `fence-${++nextFence}`;
      leases.set(id, { token, until });
      return token;
    },
    async markDispatched(id, token) {
      const row = rows.get(id);
      if (!row || leases.get(id)?.token !== token) return false;
      rows.set(id, { ...row, status: 'dispatched', version: row.version + 1 });
      leases.delete(id);
      return true;
    },
    async markReconciliation(id, token) {
      const row = rows.get(id);
      if (!row || leases.get(id)?.token !== token) return false;
      rows.set(id, { ...row, status: 'needs_reconciliation', version: row.version + 1 });
      leases.delete(id);
      return true;
    },
  };
  return { store, rows, leases, queryLimits };
}

function pending(id: string, patch: Partial<BrowserPendingDispatch> = {}): BrowserPendingDispatch {
  return { id, owner: 'cto', version: 1, status: 'pending', effect: 'none', dueAt: NOW - 1, attempts: 0, ...patch };
}

test('recover dispatches only due, pre-effect jobs and persists their dispatched state', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.recoverBrowserDispatches === 'function', 'recovery module must export recoverBrowserDispatches');
  const h = recoveryHarness([pending('ready'), pending('future', { dueAt: NOW + 1 })]);
  const called: string[] = [];
  const summary = await api.recoverBrowserDispatches({ store: h.store, dispatch: async (id) => { called.push(id); }, now: NOW, limit: 10 });
  assert.deepEqual(called, ['ready']);
  assert.equal(h.rows.get('ready')?.status, 'dispatched');
  assert.equal(h.rows.get('future')?.status, 'pending');
  assert.deepEqual(summary, { scanned: 1, dispatched: 1, reconciliation: 0, skipped: 0, failed: 0 });
});

test('unknown and succeeded effects are fenced into reconciliation without redispatch', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.recoverBrowserDispatches === 'function', 'recovery module must export recoverBrowserDispatches');
  for (const effect of ['unknown', 'succeeded'] as const) {
    const h = recoveryHarness([pending(effect, { effect })]);
    let called = 0;
    await api.recoverBrowserDispatches({ store: h.store, dispatch: async () => { called++; }, now: NOW, limit: 1 });
    assert.equal(called, 0);
    assert.equal(h.rows.get(effect)?.status, 'needs_reconciliation');
    assert.equal(h.leases.size, 0);
  }
});

test('a failed dispatch is not silently reported as dispatched', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.recoverBrowserDispatches === 'function', 'recovery module must export recoverBrowserDispatches');
  const h = recoveryHarness([pending('uncertain')]);
  const summary = await api.recoverBrowserDispatches({ store: h.store, dispatch: async () => { throw new Error('queue outcome unknown'); }, now: NOW, limit: 1 });
  assert.equal(h.rows.get('uncertain')?.status, 'needs_reconciliation');
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.reconciliation, 1);
});

test('retry ceiling and indexed query limit are bounded', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.recoverBrowserDispatches === 'function', 'recovery module must export recoverBrowserDispatches');
  const h = recoveryHarness(Array.from({ length: 30 }, (_, i) => pending(`bounded-${i}`, { attempts: i === 0 ? 3 : 0 })));
  let called = 0;
  const summary = await api.recoverBrowserDispatches({ store: h.store, dispatch: async () => { called++; }, now: NOW, limit: 200 });
  assert.equal(called, 24);
  assert.equal(h.rows.get('bounded-0')?.status, 'needs_reconciliation');
  assert.equal(summary.reconciliation, 1);
  assert.equal(summary.scanned, 25);
  assert.deepEqual(h.queryLimits, [25]);
});

test('concurrent recovery passes cannot double claim or dispatch a row', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.recoverBrowserDispatches === 'function', 'recovery module must export recoverBrowserDispatches');
  const h = recoveryHarness([pending('one')]);
  let dispatches = 0;
  const input = { store: h.store, dispatch: async () => { dispatches++; await Promise.resolve(); }, now: NOW, limit: 1 };
  const summaries = await Promise.all([api.recoverBrowserDispatches(input), api.recoverBrowserDispatches(input)]);
  assert.equal(dispatches, 1);
  assert.equal(h.rows.get('one')?.status, 'dispatched');
  assert.equal(summaries.reduce((n, x) => n + x.dispatched, 0), 1);
});

test('a lost dispatched receipt is quarantined before another pass can enqueue it', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.recoverBrowserDispatches === 'function', 'recovery module must export recoverBrowserDispatches');
  const h = recoveryHarness([pending('lost-receipt')]);
  h.store.markDispatched = async () => { throw new Error('receipt acknowledgement lost'); };
  let called = 0;
  const summary = await api.recoverBrowserDispatches({ store: h.store, dispatch: async () => { called++; }, now: NOW, limit: 1 });
  assert.equal(called, 1);
  assert.equal(h.rows.get('lost-receipt')?.status, 'needs_reconciliation');
  assert.equal(summary.dispatched, 0);
  assert.equal(summary.reconciliation, 1);
});

function cleanupHarness(seed: BrowserExpiredSession[]) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  let nextFence = 0;
  const leases = new Map<string, string>();
  const queryLimits: number[] = [];
  const store: BrowserExpiredSessionStore = {
    async listExpired(now, limit) { queryLimits.push(limit); return [...rows.values()].filter((r) => r.status === 'cleanup_pending' && typeof r.expiresAt === 'number' && r.expiresAt <= now).slice(0, limit).map((r) => structuredClone(r)); },
    async claimCleanup(id, version, _until) {
      const row = rows.get(id);
      if (!row || row.version !== version || row.status !== 'cleanup_pending' || leases.has(id)) return null;
      const token = `cleanup-${++nextFence}`; leases.set(id, token); return token;
    },
    async markStopped(id, token) {
      const row = rows.get(id);
      if (!row || leases.get(id) !== token) return false;
      rows.set(id, { ...row, status: 'stopped', version: row.version + 1 }); leases.delete(id); return true;
    },
    async markCleanupFailed(id, token) {
      const row = rows.get(id);
      if (!row || leases.get(id) !== token) return false;
      rows.set(id, { ...row, status: 'cleanup_failed', version: row.version + 1 }); leases.delete(id); return true;
    },
  };
  return { store, rows, leases, queryLimits };
}

function expired(id: string, patch: Partial<BrowserExpiredSession> = {}): BrowserExpiredSession {
  return { id, owner: 'cto', providerSessionId: `opaque-${id}`, ownership: 'confirmed', version: 1, status: 'cleanup_pending', expiresAt: NOW - 1, ...patch };
}

test('expired confirmed owned sessions stop and persist a receipt state', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.cleanupExpiredBrowserSessions === 'function', 'recovery module must export cleanupExpiredBrowserSessions');
  const h = cleanupHarness([expired('stale')]);
  const stopped: string[] = [];
  const summary = await api.cleanupExpiredBrowserSessions({ store: h.store, stop: async (id) => { stopped.push(id); }, now: NOW, limit: 5 });
  assert.deepEqual(stopped, ['opaque-stale']);
  assert.equal(h.rows.get('stale')?.status, 'stopped');
  assert.deepEqual(summary, { scanned: 1, stopped: 1, failed: 0, skipped: 0 });
});

test('concurrent cleanup passes cannot claim or stop the same session twice', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.cleanupExpiredBrowserSessions === 'function', 'recovery module must export cleanupExpiredBrowserSessions');
  const h = cleanupHarness([expired('one-session')]);
  let stops = 0;
  const input = { store: h.store, stop: async () => { stops++; await Promise.resolve(); }, now: NOW, limit: 1 };
  const summaries = await Promise.all([api.cleanupExpiredBrowserSessions(input), api.cleanupExpiredBrowserSessions(input)]);
  assert.equal(stops, 1);
  assert.equal(h.rows.get('one-session')?.status, 'stopped');
  assert.equal(summaries.reduce((n, x) => n + x.stopped, 0), 1);
});

test('cleanup query and stop work are capped at 25 rows', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.cleanupExpiredBrowserSessions === 'function', 'recovery module must export cleanupExpiredBrowserSessions');
  const h = cleanupHarness(Array.from({ length: 30 }, (_, i) => expired(`bounded-${i}`)));
  let stops = 0;
  const summary = await api.cleanupExpiredBrowserSessions({ store: h.store, stop: async () => { stops++; }, now: NOW, limit: 500 });
  assert.equal(stops, 25);
  assert.equal(summary.scanned, 25);
  assert.equal(summary.stopped, 25);
  assert.deepEqual(h.queryLimits, [25]);
});

test('unknown ownership and absent expiry never trigger provider stop', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.cleanupExpiredBrowserSessions === 'function', 'recovery module must export cleanupExpiredBrowserSessions');
  const h = cleanupHarness([expired('unknown-owner', { ownership: 'unknown' }), expired('no-expiry', { expiresAt: null })]);
  let stops = 0;
  await api.cleanupExpiredBrowserSessions({ store: h.store, stop: async () => { stops++; }, now: NOW, limit: 10 });
  assert.equal(stops, 0);
  assert.equal(h.rows.get('unknown-owner')?.status, 'cleanup_pending');
  assert.equal(h.rows.get('no-expiry')?.status, 'cleanup_pending');
});

test('stop failure remains a failed cleanup receipt and cannot be reported stopped', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.cleanupExpiredBrowserSessions === 'function', 'recovery module must export cleanupExpiredBrowserSessions');
  const h = cleanupHarness([expired('failed-stop')]);
  const summary = await api.cleanupExpiredBrowserSessions({ store: h.store, stop: async () => { throw new Error('provider timeout'); }, now: NOW, limit: 1 });
  assert.equal(h.rows.get('failed-stop')?.status, 'cleanup_failed');
  assert.equal(summary.stopped, 0);
  assert.equal(summary.failed, 1);
});

test('a lost stop receipt remains cleanup failure when its fence is still current', async () => {
  const api = await optionalRecoveryModule();
  assert.ok(api && typeof api.cleanupExpiredBrowserSessions === 'function', 'recovery module must export cleanupExpiredBrowserSessions');
  const h = cleanupHarness([expired('lost-stop-receipt')]);
  h.store.markStopped = async () => { throw new Error('receipt acknowledgement lost'); };
  const summary = await api.cleanupExpiredBrowserSessions({ store: h.store, stop: async () => undefined, now: NOW, limit: 1 });
  assert.equal(h.rows.get('lost-stop-receipt')?.status, 'cleanup_failed');
  assert.equal(summary.stopped, 0);
  assert.equal(summary.failed, 1);
});
