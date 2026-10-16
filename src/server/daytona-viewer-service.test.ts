import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { URL as URLConstructor } from 'node:url';
import test from 'node:test';
import { DaytonaViewerError, DaytonaViewerHandoffService, DynamoDaytonaViewerTicketStore, type DaytonaViewerTicket, type DaytonaViewerTicketStore, type DaytonaViewerMissionBoundary } from './daytona-viewer-service.js';

const NOW = 1_900_000_000_000;
const PRINCIPAL = 'a'.repeat(64);
const SESSION = randomUUID();
const HANDLE = randomUUID();
const URL = 'https://6080-signed.proxy.daytona.works/vnc.html';
const PROOF = 'P'.repeat(43);
function fixture() {
  let now = NOW;
  const rows = new Map<string, DaytonaViewerTicket>();
  const leases = new Map<string, string>();
  const pointers = new Map<string, string>();
  const calls: string[] = [];
  let activeHandle: string | undefined;
  let activeExpiresAt = NOW + 90_000;
  let missionPhase = 'ACTIVE', missionUnknown = false, profileLeaseReleased = false;
  let humanInputReceipt: { grantHandle: string; completedAt: number; human_input_revoked: true; profile_checkpointed: true; automation_resumed: true } | undefined;
  const store: DaytonaViewerTicketStore = {
    create: async (hash, row) => { if (rows.has(hash)) return false; rows.set(hash, structuredClone(row)); return true; },
    load: async hash => structuredClone(rows.get(hash) ?? null),
    transition: async (hash, phase, next) => { const old = rows.get(hash); if (!old || old.phase !== phase || old.version + 1 !== next.version) return false; rows.set(hash, structuredClone(next)); return true; },
    acquireMissionLease: async (id, hash) => { if (leases.has(id)) return false; leases.set(id, hash); return true; },
    ownsMissionLease: async (id, hash) => leases.get(id) === hash,
    releaseMissionLease: async (id, hash) => { if (leases.get(id) === hash) leases.delete(id); },
    bindBrowser: async (hash, selector, browserHash, recoveryUntil, next) => { const row = rows.get(hash); const key = `${browserHash}:${selector}`; if (!row || (row.browserHash && row.browserHash !== browserHash) || (pointers.has(key) && pointers.get(key) !== hash)) return false; rows.set(hash, structuredClone(next)); pointers.set(key, hash); return true; },
    loadByBrowser: async (selector, browserHash) => { const hash = pointers.get(`${browserHash}:${selector}`); return hash ? { hash, ticket: structuredClone(rows.get(hash)!) } : null; },
  };
  const missions: DaytonaViewerMissionBoundary = {
    loadSession: async id => ({ sessionId: id, owner: 'cto', ownerSubjectHash: PRINCIPAL, expiresAt: NOW + 600_000, phase: missionPhase, effectUnknown: missionUnknown, ...(profileLeaseReleased ? { profileLeaseReleased: true } : {}), ...(activeHandle ? { viewerGrantHandle: activeHandle } : {}), ...(humanInputReceipt ? { humanInputReceipt } : {}) }),
    getViewerGrant: async (owner, id, principal, seconds) => { assert.equal(owner, 'cto'); assert.equal(id, SESSION); assert.equal(principal, PRINCIPAL); calls.push(`mint:${seconds}`); activeHandle = HANDLE; activeExpiresAt = NOW + 90_000; return { url: URL, expiresAt: activeExpiresAt, grantHandle: HANDLE }; },
    resumeViewerGrant: async (_owner, _id, _principal, handle) => { assert.equal(handle, HANDLE); calls.push('resume'); return { url: URL, expiresAt: activeExpiresAt, grantHandle: HANDLE }; },
    completeHumanInput: async () => { calls.push('complete'); humanInputReceipt = { grantHandle: activeHandle!, completedAt: now, human_input_revoked: true, profile_checkpointed: true, automation_resumed: true }; activeHandle = undefined; return { status: 'saved', human_input_revoked: true, receipt: humanInputReceipt }; },
    renewViewerGrant: async (_owner, _id, _principal, handle, notAfter) => { assert.equal(handle, HANDLE); calls.push('renew'); activeHandle = HANDLE; activeExpiresAt = Math.min(now + 90_000, notAfter); return { url: URL, expiresAt: activeExpiresAt, grantHandle: HANDLE }; },
    stop: async () => { calls.push('stop'); missionPhase = 'CLOSED'; missionUnknown = false; profileLeaseReleased = true; },
  };
  return { rows, leases, store, missions, calls, setReceipt: (receipt: typeof humanInputReceipt) => { humanInputReceipt = receipt; }, markLeaseReleased: (released: boolean) => { profileLeaseReleased = released; }, advance: (ms: number) => { now += ms; }, service: new DaytonaViewerHandoffService(store, missions, () => now) };
}

test('Daytona bearer handoff persists only SHA lookup and owned mission binding; single exchange/resume preserves same grant and original expiry', async () => {
  const f = fixture();
  const start = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(start.login_url).hash.slice('#token='.length);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.expires_at, NOW + 120_000);
  assert.equal(JSON.stringify([...f.rows]).includes(token), false);
  const view = await f.service.exchange(token);
  assert.deepEqual(view, { signed_url: URL, expires_at: NOW + 90_000 });
  await assert.rejects(f.service.exchange(token));
  f.advance(5_000);
  assert.deepEqual(await f.service.resume(token), view);
  assert.deepEqual(f.calls, ['mint:120', 'resume']);
  assert.equal(JSON.stringify([...f.rows]).includes(URL), false);
  assert.equal([...f.rows.values()][0]!.expiresAt, NOW + 120_000);
  await f.service.complete(token);
  assert.deepEqual(f.calls, ['mint:120', 'resume', 'complete', 'stop']);
  assert.equal(f.leases.size, 0);
  await assert.rejects(f.service.complete(token));
});

test('prepare durably binds one browser proof; selector alone and another browser cannot recover', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7);
  const prepared = await f.service.prepare(token, PROOF);
  assert.equal(prepared.handoff_id, createHash('sha256').update(token).digest('hex').slice(0, 32));
  assert.equal(prepared.opening_expires_at, started.expires_at);
  assert.equal(prepared.mission_expires_at, NOW + 600_000);
  assert.deepEqual(await f.service.prepare(token, PROOF), prepared, 'same cookie prepare is idempotent');
  assert.equal([...f.rows.values()][0]!.browserHash, createHash('sha256').update(PROOF).digest('hex'));
  assert.equal(JSON.stringify([...f.rows]).includes(PROOF), false);
  await assert.rejects(f.service.recover(prepared.handoff_id, 'Q'.repeat(43)));
});

test('a prepared NEW ticket reports ready_for_open and only explicit openPrepared begins the one mint', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  assert.deepEqual(await f.service.status(prepared.handoff_id, PROOF), { status: 'ready_for_open', opening_expires_at: started.expires_at, mission_expires_at: NOW + 600_000 });
  const view = await f.service.openPrepared(prepared.handoff_id, PROOF);
  assert.deepEqual(view, { signed_url: URL, expires_at: NOW + 90_000 });
  assert.deepEqual(f.calls, ['mint:120']);
  await assert.rejects(f.service.openPrepared(prepared.handoff_id, PROOF), error => error instanceof DaytonaViewerError && error.code === 'operation_pending');
  assert.equal(f.calls.filter(call => call.startsWith('mint:')).length, 1);
});

test('lost exchange ticket commit is recovered by reading only the persisted exact grant; no second mint', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  const transition = f.store.transition;
  f.store.transition = async (hash, phase, next) => phase === 'ISSUING' ? false : transition(hash, phase, next);
  await assert.rejects(f.service.exchange(token, PROOF));
  assert.equal([...f.rows.values()][0]!.phase, 'ISSUING');
  f.store.transition = transition;
  assert.deepEqual(await f.service.recover(prepared.handoff_id, PROOF), { signed_url: URL, expires_at: NOW + 90_000 });
  assert.deepEqual(f.calls, ['mint:120', 'resume']);
  assert.equal([...f.rows.values()][0]!.phase, 'EXCHANGED');
});

test('expired opening ticket returns opening_expired before any provider call', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 60);
  const token = new URLConstructor(started.login_url).hash.slice(7); f.advance(60_001);
  await assert.rejects(f.service.exchange(token), error => error instanceof DaytonaViewerError && error.code === 'opening_expired');
  assert.deepEqual(f.calls, []);
});

test('unknown mint receipt remains fenced; recover never mints or clears ISSUING', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  f.missions.getViewerGrant = async () => { f.calls.push('unknown-mint'); throw new Error('private provider detail'); };
  await assert.rejects(f.service.exchange(token, PROOF));
  await assert.rejects(f.service.recover(prepared.handoff_id, PROOF));
  assert.equal([...f.rows.values()][0]!.phase, 'ISSUING');
  assert.equal(f.calls.filter(call => call === 'unknown-mint').length, 1);
});

test('expired grant renewal is explicit, keeps original opening deadline, and recovers a lost renewal commit by exact read', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 300);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  await f.service.exchange(token, PROOF); f.advance(90_001);
  assert.deepEqual(await f.service.status(prepared.handoff_id, PROOF), { status: 'pending', opening_expires_at: started.expires_at, mission_expires_at: NOW + 600_000, viewer_expires_at: NOW + 90_000, renewal_allowed: true });
  const transition = f.store.transition;
  f.store.transition = async (hash, phase, next) => phase === 'RENEWING' ? false : transition(hash, phase, next);
  await assert.rejects(f.service.renew(prepared.handoff_id, PROOF));
  assert.equal([...f.rows.values()][0]!.phase, 'RENEWING');
  f.store.transition = transition;
  const renewed = await f.service.recover(prepared.handoff_id, PROOF);
  assert.equal(renewed.expires_at, NOW + 180_001);
  assert.equal([...f.rows.values()][0]!.expiresAt, started.expires_at, 'opening deadline is immutable');
  assert.equal([...f.rows.values()][0]!.phase, 'EXCHANGED');
  assert.equal(f.calls.filter(call => call.startsWith('mint:')).length, 1);
  assert.equal(f.calls.filter(call => call === 'renew').length, 1);
});

test('Done acknowledgement loss reconciles a closed exact-receipt mission without repeating checkpoint or stop', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  await f.service.exchange(token, PROOF);
  const transition = f.store.transition;
  f.store.transition = async (hash, phase, next) => {
    if (phase === 'COMPLETING' && next.phase === 'SAVED') return false;
    return transition(hash, phase, next);
  };
  await assert.rejects(f.service.complete(prepared.handoff_id, PROOF));
  f.store.transition = transition;
  assert.deepEqual(await f.service.status(prepared.handoff_id, PROOF), { status: 'saved', opening_expires_at: started.expires_at, mission_expires_at: NOW + 600_000 });
  assert.equal([...f.rows.values()][0]!.phase, 'SAVED'); assert.equal(f.leases.size, 0);
  assert.equal(f.calls.filter(call => call === 'complete').length, 1);
  assert.equal(f.calls.filter(call => call === 'stop').length, 1);
});

test('lost core Done acknowledgement exposes cleanup_required; explicit reconcile stops once without checkpoint replay', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  await f.service.exchange(token, PROOF);
  f.missions.completeHumanInput = async () => { f.calls.push('complete-ack-lost'); f.setReceipt({ grantHandle: HANDLE, completedAt: NOW, human_input_revoked: true, profile_checkpointed: true, automation_resumed: true }); throw new Error('private lost acknowledgement'); };
  await assert.rejects(f.service.complete(prepared.handoff_id, PROOF));
  assert.deepEqual(await f.service.status(prepared.handoff_id, PROOF), { status: 'pending', opening_expires_at: started.expires_at, mission_expires_at: NOW + 600_000, cleanup_required: true });
  assert.deepEqual(await f.service.reconcile(prepared.handoff_id, PROOF), { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true });
  assert.deepEqual(f.calls.slice(-2), ['complete-ack-lost', 'stop']);
  assert.equal(f.calls.includes('complete'), false);
});

test('closed completion receipt is not Saved until profile lease release is positively read', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  await f.service.exchange(token, PROOF);
  const stop = f.missions.stop; let stops = 0;
  f.missions.stop = async (...args) => { await stop(...args); if (++stops === 1) f.markLeaseReleased(false); };
  await assert.rejects(f.service.complete(prepared.handoff_id, PROOF));
  assert.deepEqual(await f.service.status(prepared.handoff_id, PROOF), { status: 'pending', opening_expires_at: started.expires_at, mission_expires_at: NOW + 600_000, cleanup_required: true });
  assert.deepEqual(await f.service.reconcile(prepared.handoff_id, PROOF), { status: 'saved', human_input_revoked: true, checkpoint_saved: true, mission_released: true });
  assert.equal(stops, 2);
});

test('Cancel is terminal expired, never saved, and remains readable after its lease is released', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  await f.service.exchange(token, PROOF); await f.service.expire(prepared.handoff_id, PROOF);
  assert.deepEqual(await f.service.status(prepared.handoff_id, PROOF), { status: 'expired', opening_expires_at: started.expires_at, mission_expires_at: NOW + 600_000 });
  assert.equal(f.leases.size, 0);
  assert.equal(f.calls.includes('complete'), false);
});

test('expiry cleanup can stop a mission after its deadline but cannot mint or renew', async () => {
  const f = fixture(); const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7); const prepared = await f.service.prepare(token, PROOF);
  await f.service.exchange(token, PROOF); f.advance(600_001);
  assert.deepEqual(await f.service.expire(prepared.handoff_id, PROOF), { status: 'expired', human_input_revoked: true, mission_released: true });
  assert.equal(f.calls.filter(call => call.startsWith('mint:')).length, 1);
  assert.equal(f.leases.size, 0);
});

test('Daytona bearer adapter rejects foreign/expired missions before minting and keeps one durable mission handoff lease', async () => {
  const f = fixture();
  await assert.rejects(f.service.issue('cro', SESSION, PRINCIPAL, 60));
  await assert.rejects(f.service.issue('cto', SESSION, 'b'.repeat(64), 60));
  await assert.rejects(f.service.issue('cto', SESSION, PRINCIPAL, 601));
  const first = await f.service.issue('cto', SESSION, PRINCIPAL, 60);
  await assert.rejects(f.service.issue('cto', SESSION, PRINCIPAL, 60));
  f.advance(60_001);
  await assert.rejects(f.service.exchange(new URLConstructor(first.login_url).hash.slice(7)));
  assert.deepEqual(f.calls, []);
});

test('delayed viewer exchange passes the unchanged absolute ticket deadline to grant creation', async () => {
  const f = fixture();
  const started = await f.service.issue('cto', SESSION, PRINCIPAL, 300);
  const token = new URLConstructor(started.login_url).hash.slice(7);
  let mints = 0;
  f.missions.getViewerGrant = async (...args) => {
    const notAfter = (args as unknown[])[4];
    assert.equal(notAfter, started.expires_at);
    mints++; f.advance(1_224);
    return { url: URL, grantHandle: HANDLE, expiresAt: Math.min(NOW + 301_224, notAfter as number) };
  };
  const view = await f.service.exchange(token);
  assert.equal(view.expires_at, started.expires_at);
  assert.equal([...f.rows.values()][0]!.expiresAt, started.expires_at);
  assert.equal([...f.rows.values()][0]!.phase, 'EXCHANGED');
  assert.equal(mints, 1);
});

test('Daytona mint ambiguity and lost durable grant receipt retain permanent effect fence and lease without retries', async () => {
  for (const mode of ['provider', 'store']) {
    const f = fixture();
    const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
    const token = new URLConstructor(started.login_url).hash.slice(7);
    if (mode === 'provider') f.missions.getViewerGrant = async () => { f.calls.push('unknown'); throw new Error('raw-secret'); };
    else { const save = f.store.transition; f.store.transition = async (hash, phase, next) => { if (phase === 'ISSUING') throw new Error('storage-unknown'); return save(hash, phase, next); }; }
    await assert.rejects(f.service.exchange(token));
    assert.equal([...f.rows.values()][0]!.phase, 'ISSUING');
    assert.equal(f.leases.size, 1);
    const count = f.calls.length;
    await assert.rejects(f.service.exchange(token));
    await assert.rejects(f.service.resume(token));
    await assert.rejects(f.service.complete(token));
    assert.equal(f.calls.length, count);
  }
});

test('Daytona resume/Done serialize on durable phase and unknown revocation never releases lease or retries', async () => {
  const f = fixture();
  const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7);
  await f.service.exchange(token);
  let finish: ((value: { url: string; expiresAt: number; grantHandle: string }) => void) | undefined;
  f.missions.resumeViewerGrant = async () => new Promise(resolve => { finish = resolve; });
  const pending = f.service.resume(token);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await assert.rejects(f.service.complete(token));
  assert.equal(f.calls.includes('complete'), false);
  finish!({ url: URL, expiresAt: NOW + 90_000, grantHandle: HANDLE });
  await pending;
  f.missions.completeHumanInput = async () => { f.calls.push('unknown-revoke'); throw new Error('uncertain'); };
  await assert.rejects(f.service.complete(token));
  assert.equal([...f.rows.values()][0]!.phase, 'COMPLETING');
  assert.equal(f.leases.size, 1);
  await assert.rejects(f.service.resume(token));
  await assert.rejects(f.service.complete(token));
  assert.equal(f.calls.filter(call => call === 'unknown-revoke').length, 1);
});

test('Daytona cancellation requires confirmed owned mission stop before lease release', async () => {
  const f = fixture();
  const started = await f.service.issue('cto', SESSION, PRINCIPAL, 120);
  const token = new URLConstructor(started.login_url).hash.slice(7);
  await f.service.exchange(token);
  assert.deepEqual(await f.service.expire(token), { status: 'expired', human_input_revoked: true, mission_released: true });
  assert.deepEqual(f.calls, ['mint:120', 'stop']);
  assert.equal(f.leases.size, 0);
});

test('Daytona Dynamo ticket wire uses exact phase/version and owner fences; metadata never stores bearer URLs', async () => {
  const requests: Record<string, unknown>[] = [];
  const store = new DynamoDaytonaViewerTicketStore({ now: () => NOW, resolveCredentials: async () => ({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' }), fetchImpl: async (_input, init) => { requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return new Response('{}', { status: 200 }); } });
  const hash = 'b'.repeat(64);
  const row: DaytonaViewerTicket = { owner: 'cto', principalHash: PRINCIPAL, sessionId: SESSION, expiresAt: NOW + 120000, phase: 'NEW', version: 0 };
  await store.create(hash, row);
  await store.transition(hash, 'NEW', { ...row, phase: 'ISSUING', version: 1 });
  await store.acquireMissionLease(SESSION, hash);
  await store.releaseMissionLease(SESSION, hash);
  assert.equal(requests[0]!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal((requests[0]!.Item as Record<string, unknown>).expiresAtEpoch, undefined, 'unknown-effect reconciliation metadata cannot disappear while its permanent lease remains');
  assert.equal(requests[1]!.ConditionExpression, '#phase = :old AND #version = :oldVersion');
  assert.deepEqual((requests[1]!.ExpressionAttributeValues as Record<string, unknown>)[':oldVersion'], { N: '0' });
  assert.equal(requests[2]!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(requests[3]!.ConditionExpression, '#owner = :owner');
  assert.equal(JSON.stringify(requests).includes(URL), false);
});

test('Daytona Dynamo codec rejects missing ownership and unpaired grant metadata', async () => {
  let payload: Record<string, unknown> = { principalHash: PRINCIPAL, sessionId: SESSION, expiresAt: NOW + 100000, phase: 'NEW', version: 0 };
  const hash = 'b'.repeat(64);
  const store = new DynamoDaytonaViewerTicketStore({ resolveCredentials: async () => ({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' }), fetchImpl: async () => new Response(JSON.stringify({ Item: { pk: { S: `DAYTONA_VIEWER#TICKET#${hash}` }, payload: { S: JSON.stringify(payload) }, phase: { S: 'NEW' }, version: { N: '0' } } })) });
  await assert.rejects(store.load(hash));
  payload = { ...payload, owner: 'cto', grantExpiresAt: NOW + 90000 };
  await assert.rejects(store.load(hash));
});

test('browser proof binding uses a Dynamo transaction without top-level TableName and stores only hashes', async () => {
  let request: Record<string, unknown> | undefined;
  const store = new DynamoDaytonaViewerTicketStore({ resolveCredentials: async () => ({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' }), fetchImpl: async (_input, init) => { request = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response('{}'); } });
  const hash = 'c'.repeat(64), browserHash = 'd'.repeat(64), selector = hash.slice(0, 32);
  const ticket: DaytonaViewerTicket = { owner: 'cto', principalHash: PRINCIPAL, sessionId: SESSION, expiresAt: NOW + 120_000, missionExpiresAt: NOW + 600_000, browserHash, recoveryUntil: NOW + 600_000, phase: 'NEW', version: 1 };
  assert.equal(await store.bindBrowser(hash, selector, browserHash, NOW + 600_000, ticket), true);
  assert.equal(request!.TableName, undefined);
  assert.equal(Array.isArray(request!.TransactItems), true);
  assert.equal((request!.TransactItems as unknown[]).length, 2);
  assert.equal(JSON.stringify(request).includes(PROOF), false);
  assert.equal(JSON.stringify(request).includes(browserHash), true);
});
