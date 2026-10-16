import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { requestContext, type RequestContext } from './request-context.js';
import { companyEnrollmentTemplate, DaytonaCompanyEnrollment } from './daytona-company-enrollment.js';
import type { DaytonaBinding, DaytonaBrowserStore, DaytonaProvider } from '../tools/browser-daytona/contract.js';

const sandbox = 'c8a26ccf-1755-4bd2-83d6-52d5164b2e84';
const connection = '11111111-1111-4111-8111-111111111111';
const owners = ['cto', 'cfo', 'clo', 'coo', 'cro', 'developer', 'wefunder-campaign-director'];
const env = { DAYTONA_COMPANY_ENROLLMENT_ENABLED: 'true', DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: sandbox, DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256: 'b'.repeat(64) };
const principal = (owner: string) => createHash('sha256').update(`${owner}\0connection:${connection}`).digest('hex');
function fixture(configuration: NodeJS.ProcessEnv = env) {
  const rows = new Map<string, DaytonaBinding>(); const calls: string[] = [];
  const state = { public: false, checkpoint: true, v2: true, busy: false, foreign: false, loseWrite: false, conflict: false, guard: true };
  const store = { loadBinding: async (key: string) => { calls.push('load'); return rows.get(key) ?? null; }, createBinding: async (binding: DaytonaBinding) => {
    calls.push('create'); if (state.conflict) { rows.set(binding.profileKey, { ...binding, sandboxId: '22222222-2222-4222-8222-222222222222' }); return false; }
    if (rows.has(binding.profileKey)) return false; rows.set(binding.profileKey, { ...binding }); if (state.loseWrite) throw new Error('PRIVATE'); return true;
  } } as DaytonaBrowserStore;
  const provider = { inspect: async () => { calls.push('inspect'); return { sandboxId: sandbox, state: 'started', public: state.public }; }, probe: async (binding: DaytonaBinding) => {
    calls.push('probe'); return { ready: true, profileKey: state.foreign ? 'foreign' : binding.profileKey, profilePath: binding.profilePath, checkpointReady: state.checkpoint, browserPid: 21, supervisorPid: 20, ...(state.v2 ? { runtimeProtocol: 2, multiMissionReady: !state.busy } : {}) };
  } } as DaytonaProvider;
  const enrollment = new DaytonaCompanyEnrollment(companyEnrollmentTemplate(configuration, [sandbox]), store, provider, () => { calls.push('guard'); if (!state.guard) throw new Error('unhealthy'); });
  const run = (owner = 'cto', overrides: Partial<RequestContext> = {}, hash = principal(owner), profile?: string) => requestContext.run({ callerAgent: owner, callerHash: 'a'.repeat(64), correlationId: 'synthetic', authKind: 'oauth', authSubject: 'actual-signed-client', authConnectionId: connection, ...overrides }, () => enrollment.ensure(owner, hash, profile));
  return { rows, calls, state, run };
}
test('root opt-in is off by default and exact allowed sandbox plus actual retained SHA are mandatory', async () => {
  const h = fixture({}); await h.run(); assert.deepEqual(h.calls, []);
  for (const bad of [{ ...env, DAYTONA_COMPANY_ENROLLMENT_SANDBOX_ID: '22222222-2222-4222-8222-222222222222' }, { ...env, DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256: undefined }]) assert.throws(() => companyEnrollmentTemplate(bad, [sandbox]));
});
test('all seven signed company contexts create only exact virtual bindings after fresh private V2/keyring readiness', async () => {
  const h = fixture();
  for (const owner of owners) {
    await h.run(owner); const row = h.rows.get(`${owner}-${principal(owner)}`)!;
    assert.equal(row.owner, owner); assert.equal(row.ownerSubjectHash, principal(owner)); assert.equal(row.sandboxId, sandbox);
    assert.equal(row.sharedProfileKey, 'company-browser'); assert.equal(row.profilePath, '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium');
    assert.equal(row.readinessReceiptSha256, env.DAYTONA_COMPANY_ENROLLMENT_READINESS_SHA256);
  }
  assert.equal(h.rows.size, 7); assert.ok(h.calls.indexOf('probe') < h.calls.indexOf('create'));
  assert.equal(h.calls[h.calls.indexOf('create') + 1], 'load');
});
test('missing, legacy, foreign, static and protected contexts cannot cause any lookup/probe/write', async () => {
  for (const [owner, overrides, hash, profile] of [
    ['clo-personal', {}, principal('clo-personal')], ['cto', { authKind: 'codex' }, principal('cto')],
    ['cto', { authConnectionId: undefined }, principal('cto')], ['cto', { authConnectionId: 'client-not-connection' }, principal('cto')],
    ['cto', { authSubject: undefined }, principal('cto')], ['cto', { callerAgent: 'cfo' }, principal('cto')],
    ['cto', {}, 'c'.repeat(64)], ['cto', {}, principal('cto'), 'foreign-profile'],
  ] as Array<[string, Partial<RequestContext>, string, string?]>) {
    const h = fixture(); await assert.rejects(h.run(owner, overrides, hash, profile)); assert.deepEqual(h.calls, []);
  }
});
test('unready, public, busy and foreign proofs never enroll', async () => {
  for (const key of ['public', 'checkpoint', 'v2', 'busy', 'foreign', 'guard'] as const) {
    const h = fixture(); h.state[key] = !h.state[key]; await assert.rejects(h.run()); assert.equal(h.rows.size, 0); assert.equal(h.calls.includes('create'), false);
  }
});
test('exact existing bindings are verified fresh but conflicting existing/racing rows never get overwritten', async () => {
  const h = fixture(); await h.run(); h.calls.length = 0; await h.run(); assert.equal(h.calls.includes('create'), false); assert.equal(h.calls.includes('probe'), true);
  h.rows.get(`cto-${principal('cto')}`)!.readinessReceiptSha256 = 'c'.repeat(64); h.calls.length = 0;
  await assert.rejects(h.run()); assert.deepEqual(h.calls, ['load']);
  const race = fixture(); race.state.conflict = true; await assert.rejects(race.run()); assert.equal(race.calls.filter(x => x === 'create').length, 1);
});
test('lost conditional-create acknowledgement is not retried in request; later exact readback reconciles without another create', async () => {
  const h = fixture(); h.state.loseWrite = true; await assert.rejects(h.run()); assert.equal(h.calls.filter(x => x === 'create').length, 1);
  await h.run(); assert.equal(h.calls.filter(x => x === 'create').length, 1);
});
