import test from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaBrowserService } from './service.js';
import { DaytonaBrowserError, type DaytonaBinding, type DaytonaMission, type DaytonaBrowserStore, type DaytonaProvider } from './contract.js';

const hash = 'a'.repeat(64);
const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: hash, sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
function fixture() {
  let now = 1000; let grantExpiry = 0; const sessions = new Map<string, DaytonaMission>(); const locks = new Map<string, string>(); const leases = new Map<string, string>();
  const state = { opened: 0, executed: 0, released: 0, checkpoints: 0, grants: 0, revoked: 0, probes: 0, readinessForeign: false, checkpointReady: true, runtimeProtocol: undefined as 2 | undefined, multiMissionReady: true, openBusy: false, executeBusy: false, pauseBusy: false, pauseFails: false, resumeFails: false, public: false, openFails: false, executeFails: false, releaseFails: false, grantFails: false, revokeFails: false, executionResult: undefined as unknown, checkpointSession: undefined as DaytonaMission | undefined, flow: [] as string[] };
  const bindings = new Map([[binding.profileKey, binding], ['profile-two', { ...binding, owner: 'cfo', ownerSubjectHash: 'c'.repeat(64), profileKey: 'profile-two', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-two/chromium' }]]);
  const store: DaytonaBrowserStore = {
    loadBinding: async key => bindings.has(key) ? { ...bindings.get(key)! } : null, createBinding: async () => false,
    loadSession: async id => sessions.has(id) ? { ...sessions.get(id)! } : null,
    createSession: async s => { if (sessions.has(s.sessionId)) return false; sessions.set(s.sessionId, { ...s }); return true; },
    saveSessionUnderLock: async (s, owner) => { assert.equal(locks.get(s.sessionId), owner); sessions.set(s.sessionId, { ...s }); },
    acquireSessionLock: async (id, owner) => { if (locks.has(id)) return false; locks.set(id, owner); return true; },
    releaseSessionLock: async (id, owner) => { if (locks.get(id) === owner) locks.delete(id); },
    acquireProfileLease: async (key, owner) => { if (leases.has(key)) return false; leases.set(key, owner); return true; },
    ownsProfileLease: async (key, owner) => leases.get(key) === owner,
    releaseProfileLease: async (key, owner) => { if (leases.get(key) === owner) leases.delete(key); },
  };
  const provider: DaytonaProvider = {
    probe: async b => { state.probes++; return { ready: true, profileKey: state.readinessForeign ? 'foreign' : b.profileKey, profilePath: b.profilePath, checkpointReady: state.checkpointReady, browserPid: 101, supervisorPid: 100, ...(state.runtimeProtocol ? { runtimeProtocol: state.runtimeProtocol, multiMissionReady: state.multiMissionReady } : {}), unexpectedSecret: 'must-not-return' }; },
    inspect: async () => ({ sandboxId: binding.sandboxId, state: 'started', public: state.public }),
    openMission: async (_b, id, options) => { state.opened++; assert.equal(options?.runtimeProtocol, sessions.get(id)?.runtimeProtocol); if (state.openBusy) throw new DaytonaBrowserError('daytona_operation_busy'); if (state.openFails) throw new Error('unknown open'); },
    execute: async (b, _s, _a, _t, principal) => { assert.equal(principal, b.ownerSubjectHash); state.executed++; if (state.executeBusy) throw new DaytonaBrowserError('daytona_operation_busy'); if (state.executeFails) throw new Error('unknown action'); return state.executionResult ?? { url: 'https://example.com', title: 'Example', visibleText: 'public canary' }; },
    pauseAutomation: async (_b, s) => { state.flow.push('pause'); assert.equal(s.runtimeProtocol, 2); assert.equal(s.sensitiveOutputSuppressed, true); assert.equal(s.effectUnknown, true); if (state.pauseBusy) throw new DaytonaBrowserError('daytona_operation_busy'); if (state.pauseFails) throw new Error('unknown pause'); return { paused: true }; },
    resumeAutomation: async (_b, s) => { state.flow.push('resume'); assert.equal(s.sensitiveOutputSuppressed, true); assert.equal(s.effectUnknown, true); if (state.resumeFails) throw new Error('unknown resume'); return { resumed: true }; },
    checkpoint: async (_binding, session) => { state.checkpoints++; state.checkpointSession = session; state.flow.push('checkpoint'); }, releaseMission: async () => { state.released++; if (state.releaseFails) throw new Error('unknown release'); },
    viewerGrant: async () => { state.grants++; if (state.runtimeProtocol) state.flow.push('mint'); if (state.grantFails) throw new Error('unknown grant'); grantExpiry = now + 60_000; return { url: 'https://6080-synthetic.proxy.daytona.works/', expiresAt: grantExpiry, grantHandle: '12345678-1234-1234-1234-123456789abc' }; },
    readViewerGrant: async (_b, grantHandle) => ({ url: 'https://6080-synthetic.proxy.daytona.works/', expiresAt: grantExpiry, grantHandle }),
    revokeViewerGrant: async () => { state.revoked++; state.flow.push('revoke'); if (state.revokeFails) throw new Error('unknown revoke'); return { human_input_revoked: true }; },
  };
  return { service: new DaytonaBrowserService(store, provider, () => now), state, sessions, leases, locks, bindings, store, advance: (ms: number) => { now += ms; } };
}
const code = (expected: string) => (e: unknown) => e instanceof DaytonaBrowserError && e.code === expected;
test('same tool facade opens only an enrolled private running sandbox and maintains a distinct Daytona mission', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
  const session = h.sessions.get(opened.sessionId)!; assert.equal(session.provider, 'daytona'); assert.equal(session.phase, 'ACTIVE'); assert.equal(session.effectUnknown, false);
  assert.equal(opened.expiresAt, 181000); assert.equal(h.state.opened, 1); assert.equal(h.leases.get('profile-one'), opened.sessionId);
  const result = await h.service.execute('cto', opened.sessionId, { type: 'snapshot' }, 10, hash); assert.equal((result as any).title, 'Example');
  await h.service.savePersistentProfile('cto', opened.sessionId, hash); assert.equal(h.state.checkpoints, 1);
  assert.equal(h.state.checkpointSession?.sessionId, opened.sessionId);
  await h.service.stop('cto', opened.sessionId, hash); assert.equal(h.state.released, 1); assert.equal(h.sessions.get(opened.sessionId)!.phase, 'CLOSED'); assert.equal(h.leases.size, 0);
});
test('binding cutover after initial inspection but before profile acquisition never opens the stale desktop or creates a mission', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2;
  const acquire = h.store.acquireProfileLease.bind(h.store);
  h.store.acquireProfileLease = async (...args) => {
    h.bindings.set(binding.profileKey, { ...binding, sandboxId: 'dedicated-desktop' });
    return acquire(...args);
  };
  await assert.rejects(h.service.start('cto', binding.profileKey, 180, 5, hash), code('daytona_binding_changed'));
  assert.equal(h.state.opened, 0); assert.equal(h.sessions.size, 0); assert.equal(h.leases.size, 0);
});
test('historical CLOSED session stop after binding migration is owner-bound and cannot touch a successor or call the provider', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2;
  const opened = await h.service.start('cto', binding.profileKey, 180, 5, hash); await h.service.stop('cto', opened.sessionId, hash);
  h.bindings.set(binding.profileKey, { ...binding, sandboxId: 'dedicated-desktop' });
  h.leases.set(binding.profileKey, 'successor');
  await h.service.stop('cto', opened.sessionId, hash);
  assert.equal(h.state.released, 1); assert.equal(h.leases.get(binding.profileKey), 'successor');
  await assert.rejects(h.service.stop('cfo', opened.sessionId, hash), code('owner_forbidden'));
  await assert.rejects(h.service.stop('cto', opened.sessionId, 'd'.repeat(64)), code('owner_forbidden'));
  h.sessions.get(opened.sessionId)!.effectUnknown = true;
  await assert.rejects(h.service.stop('cto', opened.sessionId, hash));
  assert.equal(h.state.released, 1);
});
test('foreign owner, connection, missing enrollment, public sandbox and invalid limits have zero mission effects', async () => {
  for (const invalid of ['owner', 'principal', 'profile', 'public', 'duration', 'budget']) {
    const h = fixture(); h.state.public = invalid === 'public';
    await assert.rejects(h.service.start(invalid === 'owner' ? 'cfo' : 'cto', invalid === 'profile' ? 'missing' : 'profile-one', invalid === 'duration' ? 0 : 180, invalid === 'budget' ? 0 : 5, invalid === 'principal' ? 'c'.repeat(64) : hash));
    assert.equal(h.state.opened, 0); assert.equal(h.sessions.size, 0); assert.equal(h.leases.size, 0);
  }
});
test('one mission fences duplicate starts and unknown open or action effects are never retried', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
  await assert.rejects(h.service.start('cto', 'profile-one', 180, 5, hash), code('profile_busy'));
  h.state.executeFails = true; await assert.rejects(h.service.execute('cto', opened.sessionId, { type: 'click', selector: '#submit' }, 10, hash));
  assert.equal(h.sessions.get(opened.sessionId)!.effectUnknown, true);
  await assert.rejects(h.service.execute('cto', opened.sessionId, { type: 'snapshot' }, 10, hash), code('effect_unknown')); assert.equal(h.state.executed, 1);
  const other = fixture(); other.state.openFails = true; await assert.rejects(other.service.start('cto', 'profile-one', 180, 5, hash));
  await assert.rejects(other.service.start('cto', 'profile-one', 180, 5, hash), code('profile_busy')); assert.equal(other.state.opened, 1);
});
test('expired, foreign and suppressed missions cannot execute or sign viewers; stopping does not stop desktop resources', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 1, hash);
  await assert.rejects(h.service.execute('cfo', opened.sessionId, { type: 'snapshot' }, 10, hash));
  await assert.rejects(h.service.execute('cto', opened.sessionId, { type: 'snapshot' }, 10, 'c'.repeat(64)));
  h.sessions.get(opened.sessionId)!.sensitiveOutputSuppressed = true;
  await assert.rejects(h.service.execute('cto', opened.sessionId, { type: 'snapshot' }, 10, hash), code('sensitive_output_suppressed'));
  h.advance(181000); await assert.rejects(h.service.getViewerGrant('cto', opened.sessionId, hash)); assert.equal(h.state.grants, 0);
  await h.service.stop('cto', opened.sessionId, hash); assert.equal(h.state.released, 1); assert.equal(h.leases.size, 0);
});
test('human control stays suppressed until exact grant revocation precedes checkpoint', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
  const grant = await h.service.getViewerGrant('cto', opened.sessionId, hash, 60);
  assert.ok(grant.url.startsWith('https:')); assert.equal(h.sessions.get(opened.sessionId)!.viewerGrantHandle, grant.grantHandle);
  assert.equal(h.sessions.get(opened.sessionId)!.sensitiveOutputSuppressed, true);
  await assert.rejects(h.service.snapshot('cto', opened.sessionId, hash), code('sensitive_output_suppressed'));
  assert.deepEqual(await h.service.completeHumanInput('cto', opened.sessionId, hash), { status: 'saved', human_input_revoked: true });
  assert.deepEqual(h.state.flow, ['revoke', 'checkpoint']); assert.equal(h.sessions.get(opened.sessionId)!.sensitiveOutputSuppressed, false);
  assert.equal(h.state.checkpointSession?.sessionId, opened.sessionId);
  assert.equal(h.sessions.get(opened.sessionId)!.viewerGrantHandle, undefined);
});
test('unknown viewer grant or revocation never releases input ownership or retries provider writes', async () => {
  for (const failure of ['grant', 'revoke']) {
    const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
    if (failure === 'grant') { h.state.grantFails = true; await assert.rejects(h.service.getViewerGrant('cto', opened.sessionId, hash, 60)); await assert.rejects(h.service.stop('cto', opened.sessionId, hash), code('viewer_revocation_unknown')); }
    else { await h.service.getViewerGrant('cto', opened.sessionId, hash, 60); h.state.revokeFails = true; await assert.rejects(h.service.completeHumanInput('cto', opened.sessionId, hash)); }
    assert.equal(h.sessions.get(opened.sessionId)!.effectUnknown, true); assert.equal(h.sessions.get(opened.sessionId)!.sensitiveOutputSuppressed, true);
    await assert.rejects(h.service.completeHumanInput('cto', opened.sessionId, hash), code('effect_unknown'));
    assert.equal(h.state.checkpoints, 0); assert.equal(h.state.released, 0); assert.equal(h.leases.get('profile-one'), opened.sessionId);
  }
});
test('stopping an old mission cannot affect a successor holding the same desktop or profile', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
  h.leases.set('profile-one', 'successor');
  await assert.rejects(h.service.stop('cto', opened.sessionId, hash), code('profile_busy'));
  assert.equal(h.state.released, 0); assert.equal(h.leases.get('profile-one'), 'successor');
});
test('human viewer resume reuses only its original exact handle and expiry without another mint', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
  const grant = await h.service.getViewerGrant('cto', opened.sessionId, hash, 60); h.advance(1000);
  assert.equal(typeof h.service.resumeViewerGrant, 'function');
  assert.deepEqual(await h.service.resumeViewerGrant('cto', opened.sessionId, hash, grant.grantHandle), grant);
  assert.equal(h.state.grants, 1);
  await assert.rejects(h.service.resumeViewerGrant('cto', opened.sessionId, hash, '22222222-2222-2222-2222-222222222222'));
  await assert.rejects(h.service.resumeViewerGrant('cfo', opened.sessionId, hash, grant.grantHandle));
  h.advance(60000); await assert.rejects(h.service.resumeViewerGrant('cto', opened.sessionId, hash, grant.grantHandle));
});
test('transport wrappers unwrap to the existing gateway observation and target receipt contract', async () => {
  const h = fixture(); const opened = await h.service.start('cto', 'profile-one', 180, 5, hash);
  const observation = { url: 'https://example.com/', title: 'Actual', visibleText: 'actual observation' };
  h.state.executionResult = { observation };
  assert.deepEqual(await h.service.snapshot('cto', opened.sessionId, hash), observation);
  const pageReceipt = { selectedTargetId: 'OWNED1', createdTargetId: 'OWNED2', completed: true };
  h.state.executionResult = { observation, pageReceipt };
  assert.deepEqual(await h.service.execute('cto', opened.sessionId, { type: 'tab_create', url: 'https://example.com/' }, 10, hash), pageReceipt);
});
test('readiness is exact caller-bound fresh evidence with zero mission or lease effects', async () => {
  const h = fixture(); assert.equal(typeof h.service.readiness, 'function');
  await assert.rejects(h.service.readiness('cfo', binding.profileKey, hash));
  await assert.rejects(h.service.readiness('cto', binding.profileKey, 'c'.repeat(64)));
  assert.equal(h.state.probes, 0);
  const proof = await h.service.readiness('cto', binding.profileKey, hash);
  assert.equal(proof.checkpointReady, true); assert.equal('unexpectedSecret' in proof, false);
  h.state.checkpointReady = false;
  assert.equal((await h.service.readiness('cto', binding.profileKey, hash)).checkpointReady, false, 'Do not cache another profile or earlier readiness result');
  h.state.readinessForeign = true;
  await assert.rejects(h.service.readiness('cto', binding.profileKey, hash));
  assert.equal(h.state.opened, 0); assert.equal(h.sessions.size, 0); assert.equal(h.leases.size, 0);
});

test('automation alias requires exact fresh V2 proof before any mission or lease', async () => {
  for (const invalid of ['absent', 'busy', 'foreign', 'checkpoint']) {
    const h = fixture(); if (invalid !== 'absent') h.state.runtimeProtocol = 2;
    h.state.multiMissionReady = invalid !== 'busy'; h.state.readinessForeign = invalid === 'foreign'; h.state.checkpointReady = invalid !== 'checkpoint';
    await assert.rejects(h.service.start('cto', binding.profileKey, 180, 5, hash, { requireMultiMission: true }));
    assert.equal(h.sessions.size, 0); assert.equal(h.leases.size, 0); assert.equal(h.state.opened, 0);
  }
});
test('two principals overlap only with persisted V2 proof and keep independent principal leases', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2;
  const a = await h.service.start('cto', binding.profileKey, 180, 5, hash, { requireMultiMission: true });
  const b = await h.service.start('cfo', 'profile-two', 180, 5, 'c'.repeat(64), { requireMultiMission: true });
  assert.equal(h.sessions.get(a.sessionId)!.runtimeProtocol, 2); assert.equal(h.sessions.get(b.sessionId)!.runtimeProtocol, 2);
  assert.equal(h.leases.size, 2); assert.equal([...h.leases.keys()].some(key => key.startsWith('display-')), false);
  await h.service.stop('cto', a.sessionId, hash);
  assert.equal((await h.service.snapshot('cfo', b.sessionId, 'c'.repeat(64)) as { title: string }).title, 'Example');
  assert.equal(h.leases.size, 1); assert.equal(h.sessions.get(b.sessionId)!.phase, 'ACTIVE');
  const legacy = fixture(); await legacy.service.start('cto', binding.profileKey, 180, 5, hash);
  await assert.rejects(legacy.service.start('cfo', 'profile-two', 180, 5, 'c'.repeat(64)), code('profile_busy'));
});
test('only proven before-effect V2 admission busy releases the failed attempt', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2; h.state.openBusy = true;
  await assert.rejects(h.service.start('cto', binding.profileKey, 180, 5, hash), code('daytona_operation_busy'));
  assert.equal(h.leases.size, 0); assert.equal([...h.sessions.values()][0]!.phase, 'CLOSED');
  h.state.openBusy = false; assert.ok(await h.service.start('cto', binding.profileKey, 180, 5, hash));
  const unknown = fixture(); unknown.state.runtimeProtocol = 2; unknown.state.openFails = true;
  await assert.rejects(unknown.service.start('cto', binding.profileKey, 180, 5, hash));
  assert.equal(unknown.leases.size, 1); assert.equal([...unknown.sessions.values()][0]!.effectUnknown, true);
});
test('known V2 action mutex busy permits explicit retry without spending action budget or unknown fence', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2;
  const a = await h.service.start('cto', binding.profileKey, 180, 5, hash);
  h.state.executeBusy = true;
  await assert.rejects(h.service.snapshot('cto', a.sessionId, hash), code('daytona_operation_busy'));
  assert.equal(h.sessions.get(a.sessionId)!.effectUnknown, false); assert.equal(h.sessions.get(a.sessionId)!.actionsUsed, 0);
  h.state.executeBusy = false; await h.service.snapshot('cto', a.sessionId, hash); assert.equal(h.sessions.get(a.sessionId)!.actionsUsed, 1);
});
test('V2 global pause precedes human mint and exact revocation checkpoint precede global resume', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2;
  const a = await h.service.start('cto', binding.profileKey, 180, 5, hash);
  await h.service.getViewerGrant('cto', a.sessionId, hash, 60);
  await h.service.completeHumanInput('cto', a.sessionId, hash);
  assert.deepEqual(h.state.flow, ['pause', 'mint', 'revoke', 'checkpoint', 'resume']);
  assert.equal(h.sessions.get(a.sessionId)!.sensitiveOutputSuppressed, false);
});
test('V2 known pause busy never mints while unknown pause never clears suppression or its lease', async () => {
  for (const known of [true, false]) {
    const h = fixture(); h.state.runtimeProtocol = 2;
    const a = await h.service.start('cto', binding.profileKey, 180, 5, hash);
    h.state.pauseBusy = known; h.state.pauseFails = !known;
    await assert.rejects(h.service.getViewerGrant('cto', a.sessionId, hash, 60));
    assert.equal(h.state.grants, 0); assert.equal(h.sessions.get(a.sessionId)!.effectUnknown, !known);
    assert.equal(h.sessions.get(a.sessionId)!.sensitiveOutputSuppressed, !known);
    if (!known) await assert.rejects(h.service.stop('cto', a.sessionId, hash), code('viewer_revocation_unknown'));
    assert.equal(h.leases.get(binding.profileKey), a.sessionId);
  }
});
test('V2 unsupported global browser shortcuts report a capability error before spending or fencing an action', async () => {
  const h = fixture(); h.state.runtimeProtocol = 2;
  const a = await h.service.start('cto', binding.profileKey, 180, 5, hash);
  for (const key of ['KeyP', 'KeyS', 'KeyF'] as const) await assert.rejects(h.service.execute('cto', a.sessionId, { type: 'press_key', key, modifiers: 2 }, 10, hash), code('daytona_global_shortcut_unsupported'));
  await assert.rejects(h.service.execute('cto', a.sessionId, { type: 'press_key', key: 'KeyC', modifiers: 10 }, 10, hash), code('daytona_clipboard_modifier_unsupported'));
  assert.equal(h.state.executed, 0); assert.equal(h.sessions.get(a.sessionId)!.actionsUsed, 0); assert.equal(h.sessions.get(a.sessionId)!.effectUnknown, false);
});
