import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DaytonaViewerNotMintedError, type DaytonaBinding, type DaytonaMission } from './contract.js';

const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const mission: DaytonaMission = { provider: 'daytona', sessionId: '12345678-1234-4234-8234-123456789abc', owner: 'cto', ownerSubjectHash: binding.ownerSubjectHash, profileKey: binding.profileKey, sandboxId: binding.sandboxId, expiresAt: Date.now() + 180000, actionsUsed: 1, actionBudget: 25, effectUnknown: true, phase: 'ACTIVE' };
const wefunderBinding: DaytonaBinding = { ...binding, owner: 'wefunder-campaign-director', ownerSubjectHash: 'e'.repeat(64), profileKey: 'wefunder-campaign-director-' + 'e'.repeat(64), profilePath: '/home/otcbrowser/.local/share/otchealth-browser/wefunder-campaign-director-' + 'e'.repeat(64) + '/chromium' };
const wefunderMission: DaytonaMission = { ...mission, owner: wefunderBinding.owner, ownerSubjectHash: wefunderBinding.ownerSubjectHash, profileKey: wefunderBinding.profileKey, runtimeProtocol: 2 };
const token = 'server-only-secret-not-for-output';
const organizationId = '501db94e-10ee-4bc8-9cca-23c793c67524';
const sharedBinding = { ...binding, profileKey: `cto-${binding.ownerSubjectHash}`, sharedProfileKey: 'company-browser' as const, profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium' };
const sharedRuntime = { profileKey: 'company-browser', profilePath: sharedBinding.profilePath };
const sharedMission = { ...mission, profileKey: sharedBinding.profileKey };
async function client(options: Record<string, unknown> = {}) {
  const module = await import('./client.js').catch(() => null);
  assert.equal(typeof module?.DaytonaApiBrowserProvider, 'function', 'concrete Daytona API provider is missing');
  return new module!.DaytonaApiBrowserProvider({ apiBaseUrl: 'https://app.daytona.test/api', organizationId, resolveApiToken: async () => token, toolboxAllowedOrigins: ['https://proxy.daytona.test'], ...options } as any);
}
function network(runtimeBinding: Pick<DaytonaBinding, 'profileKey' | 'profilePath'> = binding) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const state = { sandbox: { id: binding.sandboxId, organizationId, state: 'started', public: false }, foreignReceipt: false, status: 200, calls: 0, payloads: [] as any[], pageReceipt: undefined as any, checkpointReady: true, checkpointAfter: 102, result: undefined as any, processResponse: undefined as any, promotionForeign: false, omitPromotionProtocol: false, forgePromotionProtocol: false, afterPrepare: undefined as (() => void) | undefined };
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init }); state.calls++;
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
    if (url.endsWith('/toolbox-proxy-url')) return Response.json({ url: 'https://proxy.daytona.test/toolbox' });
    if (url.includes('/files/')) {
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      return Response.json({ errors: null });
    }
    if (url.endsWith('/process/execute')) {
      assert.equal(init.method, 'POST'); const body = JSON.parse(String(init.body));
      if (body.command.startsWith('sudo -n python3 -I ')) {
        assert.match(body.command, /^sudo -n python3 -I \/opt\/otchealth-browser\/transfer-stage\.py --payload [A-Za-z0-9_-]+$/);
        const payload = JSON.parse(Buffer.from(body.command.split(' ').at(-1), 'base64url').toString()); state.payloads.push({ op: 'promote', ...payload });
        return Response.json({ exitCode: 0, result: JSON.stringify({ version: 1, ok: true, staged: true, profileKey: state.promotionForeign ? 'other' : payload.profileKey, sessionId: payload.sessionId, byteLength: payload.byteLength, sha256: payload.sha256, ...(!state.omitPromotionProtocol && (payload.runtimeProtocol === 2 || state.forgePromotionProtocol) ? { runtimeProtocol: 2 } : {}) }) });
      }
      assert.match(body.command, /^sudo -n runuser -u otcbrowser -- python3(?: -I)? \/opt\/otchealth-browser\/browser-dispatcher\.py --payload [A-Za-z0-9_-]+$/);
      assert.ok(body.timeout >= 1 && body.timeout <= 18);
      const payload = JSON.parse(Buffer.from(body.command.split(' ').at(-1), 'base64url').toString()); state.payloads.push(payload);
      const result = payload.upload ? (payload.upload.phase === 'prepare' ? { prepared: true } : { fileReceipt: { status: 'attached', ...Object.fromEntries(Object.entries(payload.upload.files[0]).filter(([key]) => key !== 'relativePath')) } }) : state.result ?? (payload.op === 'probe' ? { ready: true, cdpLoopback: true, profileVerified: true, checkpointReady: state.checkpointReady, profileKey: runtimeBinding.profileKey, profilePath: runtimeBinding.profilePath, browserPid: 101, supervisorPid: 100, encryptedKeyringUnlocked: state.checkpointReady } : payload.op === 'checkpoint' ? { checkpointed: true, gracefulClosed: true, keyringSessionRetained: true, cdpLoopback: true, profileVerified: true, profileKey: runtimeBinding.profileKey, profilePath: runtimeBinding.profilePath, sessionId: payload.sessionId, principalHash: payload.principalHash, browserPidBefore: 101, browserPidAfter: state.checkpointAfter, supervisorPid: 100, tabsReset: true } : payload.op === 'open' ? { ready: true, cdpLoopback: true, profileVerified: true } : payload.op === 'release' ? { released: true } : { url: 'https://example.com/', title: 'Example', visibleText: 'Actual fixture page', ...(state.pageReceipt ? { pageReceipt: state.pageReceipt } : {}) });
      if (payload.upload?.phase === 'prepare') state.afterPrepare?.();
      const envelope = { version: 1, ok: true, profileKey: state.foreignReceipt ? 'foreign-profile' : runtimeBinding.profileKey, profilePath: runtimeBinding.profilePath, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}), result };
      return Response.json(state.processResponse ?? { exitCode: 0, result: JSON.stringify(envelope) }, { status: state.status });
    }
    assert.equal(url, 'https://app.daytona.test/api/sandbox/sandbox-one');
    return Response.json(state.sandbox);
  };
  return { fetchImpl, requests, state };
}
test('inspect reads only the exact enrolled sandbox and requires actual started private identity', async () => {
  const n = network(); const c = await client({ fetchImpl: n.fetchImpl });
  assert.deepEqual(await c.inspect(binding), { sandboxId: binding.sandboxId, state: 'started', public: false });
  assert.deepEqual(n.requests.map(r => r.url), ['https://app.daytona.test/api/sandbox/sandbox-one']);
  n.state.sandbox.id = 'foreign'; await assert.rejects(c.inspect(binding));
  n.state.sandbox.id = binding.sandboxId; n.state.sandbox.public = true; await assert.rejects(c.openMission(binding, mission.sessionId));
  assert.equal(n.requests.some(r => r.init.method === 'POST'), false);
});
test('expired viewer deadline is a typed no-mint receipt only before invoking the private viewer port', async () => {
  let calls = 0;
  let portError: Error = new Error('port failure');
  const viewer = { mint: async () => { calls++; throw portError; }, read: async () => { throw new Error('unused'); }, revoke: async () => ({ human_input_revoked: true as const }) };
  const c = await client({ viewer });
  await assert.rejects(c.viewerGrant(binding, 60, Date.now() - 1), error => error instanceof DaytonaViewerNotMintedError);
  assert.equal(calls, 0);
  await assert.rejects(c.viewerGrant(binding, 60, Date.now() + 60_000), error => !(error instanceof DaytonaViewerNotMintedError));
  assert.equal(calls, 1);
  portError = new DaytonaViewerNotMintedError();
  await assert.rejects(c.viewerGrant(binding, 60, Date.now() + 60_000), error => !(error instanceof DaytonaViewerNotMintedError));
  assert.equal(calls, 2);
});
test('checkpoint readiness is exact-binding runtime evidence and checkpoint requires trusted mission close/reopen proof', async () => {
  const n = network(); const c = await client({ fetchImpl: n.fetchImpl });
  assert.equal(c.capabilities.checkpoint, false, 'constructor presence cannot enable the human alias');
  const readiness = await c.probe(binding);
  assert.equal(readiness.checkpointReady, true); assert.equal(readiness.profileKey, binding.profileKey);
  assert.equal(c.capabilities.checkpoint, false, 'one profile proof must not enable every enrolled profile');
  n.state.checkpointReady = false; assert.equal((await c.probe(binding)).checkpointReady, false);
  const before = n.requests.length; await assert.rejects(c.checkpoint(binding)); assert.equal(n.requests.length, before);
  await c.checkpoint(binding, mission);
  assert.equal(n.state.payloads.at(-1).op, 'checkpoint'); assert.equal(n.state.payloads.at(-1).sessionId, mission.sessionId);
  assert.equal(n.state.payloads.at(-1).principalHash, binding.ownerSubjectHash);
  n.state.checkpointAfter = 101; await assert.rejects(c.checkpoint(binding, mission));
  const count = n.requests.length; await assert.rejects(c.checkpoint(binding, { ...mission, ownerSubjectHash: 'c'.repeat(64) })); assert.equal(n.requests.length, count);
});
test('shared membership uses one physical runtime key while readiness, missions and principal remain virtual', async () => {
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  const readiness = await c.probe(sharedBinding);
  assert.equal(readiness.profileKey, sharedBinding.profileKey); assert.equal(readiness.profilePath, sharedBinding.profilePath);
  await c.openMission(sharedBinding, sharedMission.sessionId);
  await c.execute(sharedBinding, sharedMission, { type: 'snapshot' }, 10, sharedBinding.ownerSubjectHash);
  await c.checkpoint(sharedBinding, sharedMission);
  await c.releaseMission(sharedBinding, sharedMission);
  for (const payload of n.state.payloads) {
    assert.equal(payload.profileKey, 'company-browser'); assert.equal(payload.profilePath, sharedBinding.profilePath);
    assert.equal(payload.principalHash, sharedBinding.ownerSubjectHash);
    if (payload.op !== 'probe') assert.equal(payload.sessionId, sharedMission.sessionId);
  }
  n.state.foreignReceipt = true; await assert.rejects(c.probe(sharedBinding));
});
test('shared upload maps only physical promotion/runtime identity and preserves virtual broker ownership', async () => {
  const n = network(sharedRuntime), f = stagedFile(), c = await client({ fetchImpl: n.fetchImpl, files: f.files });
  const result = await c.execute(sharedBinding, sharedMission, { type: 'upload', fileId: f.id, selector: '#actual-file' }, 20, sharedBinding.ownerSubjectHash);
  assert.equal((result as any).status, 'attached');
  assert.deepEqual(f.calls, [[sharedBinding.owner, f.id, sharedBinding.ownerSubjectHash]]);
  assert.deepEqual(n.state.payloads.map(p => p.op === 'promote' ? p.op : p.upload.phase), ['prepare', 'promote', 'attach']);
  for (const payload of n.state.payloads) {
    assert.equal(payload.profileKey, 'company-browser'); assert.equal(payload.sessionId, sharedMission.sessionId);
    assert.equal(payload.principalHash, sharedBinding.ownerSubjectHash);
  }
});
test('caller action fields cannot select shared membership, change profile paths or substitute another principal', async () => {
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  await assert.rejects(c.execute(sharedBinding, sharedMission, { type: 'snapshot', sharedProfileKey: 'company-browser' } as any, 10, sharedBinding.ownerSubjectHash));
  await assert.rejects(c.execute(sharedBinding, sharedMission, { type: 'snapshot' }, 10, 'd'.repeat(64)));
  await assert.rejects(c.openMission({ ...sharedBinding, profilePath: binding.profilePath }, sharedMission.sessionId));
  assert.equal(n.requests.length, 0);
});
test('two virtual members share the physical profile without inheriting one another\'s mission authority', async () => {
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  const other = { ...sharedBinding, owner: 'cfo', ownerSubjectHash: 'd'.repeat(64), profileKey: `cfo-${'d'.repeat(64)}` };
  const otherMission = { ...sharedMission, sessionId: '22345678-1234-4234-8234-123456789abc', owner: other.owner, ownerSubjectHash: other.ownerSubjectHash, profileKey: other.profileKey };
  for (const [enrolled, ownMission] of [[sharedBinding, sharedMission], [other, otherMission]] as const) {
    assert.equal((await c.probe(enrolled)).profileKey, enrolled.profileKey);
    await c.execute(enrolled, ownMission, { type: 'snapshot' }, 10, enrolled.ownerSubjectHash);
  }
  assert.deepEqual(n.state.payloads.filter(p => p.op === 'execute').map(p => [p.profileKey, p.principalHash, p.sessionId]), [
    ['company-browser', sharedBinding.ownerSubjectHash, sharedMission.sessionId], ['company-browser', other.ownerSubjectHash, otherMission.sessionId],
  ]);
  const before = n.requests.length;
  await assert.rejects(c.execute(other, sharedMission, { type: 'snapshot' }, 10, other.ownerSubjectHash));
  await assert.rejects(c.execute(sharedBinding, otherMission, { type: 'snapshot' }, 10, sharedBinding.ownerSubjectHash));
  assert.equal(n.requests.length, before);
});
test('V2 multi-mission readiness requires fresh exact physical runtime proof, never a constructor flag', async () => {
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  const proof = { ready: true, cdpLoopback: true, profileVerified: true, checkpointReady: false, profileKey: 'company-browser', profilePath: sharedBinding.profilePath, runtimeProtocol: 2, multiMissionReady: true };
  assert.equal((await c.probe(sharedBinding)).multiMissionReady, undefined);
  n.state.result = proof;
  assert.deepEqual(await c.probe(sharedBinding), { ready: true, profileKey: sharedBinding.profileKey, profilePath: sharedBinding.profilePath, checkpointReady: false, runtimeProtocol: 2, multiMissionReady: true });
  n.state.result = { ...proof, multiMissionReady: false };
  assert.equal((await c.probe(sharedBinding)).multiMissionReady, false);
  for (const bad of [{ profileKey: sharedBinding.profileKey }, { profilePath: binding.profilePath }, { runtimeProtocol: 3 }, { runtimeProtocol: undefined }, { multiMissionReady: 'true' }]) {
    n.state.result = { ...proof, ...bad }; await assert.rejects(c.probe(sharedBinding));
  }
  n.state.result = undefined;
  assert.equal((await c.probe(sharedBinding)).multiMissionReady, undefined, 'earlier proof cannot enable another probe');
});
test('V2 human pause/resume are fixed exact-mission operations and unknown receipts fail closed without replay', async () => {
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  const current = { ...sharedMission, runtimeProtocol: 2 as const, sensitiveOutputSuppressed: true };
  n.state.result = { paused: true };
  assert.deepEqual(await (c as any).pauseAutomation(sharedBinding, current), { paused: true });
  n.state.result = { resumed: true };
  assert.deepEqual(await (c as any).resumeAutomation(sharedBinding, current), { resumed: true });
  assert.deepEqual(n.state.payloads.map(p => [p.op, p.profileKey, p.sessionId, p.principalHash]), [
    ['human_pause', 'company-browser', current.sessionId, sharedBinding.ownerSubjectHash], ['human_resume', 'company-browser', current.sessionId, sharedBinding.ownerSubjectHash],
  ]);
  assert.ok(n.state.payloads.every(p => p.runtimeProtocol === 2));
  n.state.result = { resumed: false }; await assert.rejects((c as any).resumeAutomation(sharedBinding, current));
  assert.equal(n.state.payloads.length, 3, 'unknown pause/resume ACK is never automatically replayed');
  const before = n.requests.length;
  for (const bad of [sharedMission, { ...current, ownerSubjectHash: 'd'.repeat(64) }, { ...current, phase: 'CLOSED' }, { ...current, expiresAt: Date.now() - 1 }]) await assert.rejects((c as any).pauseAutomation(sharedBinding, bad));
  assert.equal(n.requests.length, before);
});
test('only explicit trusted V2 missions select the new runtime protocol across lifecycle and transfers', async () => {
  const n = network(sharedRuntime), f = stagedFile(), c = await client({ fetchImpl: n.fetchImpl, files: f.files });
  const current = { ...sharedMission, runtimeProtocol: 2 as const };
  await c.openMission(sharedBinding, current.sessionId, { runtimeProtocol: 2 });
  await c.execute(sharedBinding, current, { type: 'snapshot' }, 10, sharedBinding.ownerSubjectHash);
  await c.execute(sharedBinding, current, { type: 'upload', fileId: f.id, selector: '#file' }, 20, sharedBinding.ownerSubjectHash);
  await c.checkpoint(sharedBinding, current); await c.releaseMission(sharedBinding, current);
  assert.ok(n.state.payloads.every(p => p.runtimeProtocol === 2));
  n.state.payloads.length = 0;
  await c.openMission(sharedBinding, sharedMission.sessionId);
  await c.execute(sharedBinding, sharedMission, { type: 'snapshot' }, 10, sharedBinding.ownerSubjectHash);
  await c.checkpoint(sharedBinding, sharedMission); await c.releaseMission(sharedBinding, sharedMission);
  assert.ok(n.state.payloads.every(p => !('runtimeProtocol' in p)), 'legacy wire must remain byte-compatible');
  const before = n.requests.length;
  await assert.rejects(c.openMission(sharedBinding, current.sessionId, { runtimeProtocol: 3 } as any));
  await assert.rejects(c.openMission(sharedBinding, current.sessionId, { sharedProfileKey: 'company-browser' } as any));
  assert.equal(n.requests.length, before);
});
test('only exact V2 known-before-effect ACKs classify busy; all other runtime outcomes remain unknown and never retry', async () => {
  const current = { ...sharedMission, runtimeProtocol: 2 as const };
  for (const [receipt, legacy, known] of [
    ...['mission_busy', 'human_active', 'other_missions_active'].map(code => [{ version: 1, ok: false, code, beforeEffect: true }, false, true]),
    [{ version: 1, ok: false, code: 'mission_busy', beforeEffect: true }, true, false],
    [{ version: 1, ok: false, code: 'mission_busy', beforeEffect: false }, false, false],
    [{ version: 1, ok: false, code: 'unknown', beforeEffect: true }, false, false],
    [{ version: 1, ok: false, code: 'mission_busy', beforeEffect: true, extra: 'forbidden' }, false, false],
  ] as Array<[Record<string, unknown>, boolean, boolean]>) {
    const n = network(sharedRuntime); let sends = 0;
    const c = await client({ fetchImpl: async (input: any, init: any) => {
      if (String(input).endsWith('/process/execute')) { sends++; return Response.json({ exitCode: 0, result: JSON.stringify(receipt) }); }
      return n.fetchImpl(input, init);
    } });
    await assert.rejects(c.execute(sharedBinding, legacy ? sharedMission : current, { type: 'snapshot' }, 10, sharedBinding.ownerSubjectHash), (error: any) => known ? error.code === 'daytona_operation_busy' : error.code !== 'daytona_operation_busy');
    assert.equal(sends, 1);
  }
});
test('selector before-effect ACK requires exact V2 profile, mission, principal, and seven-key receipt', async () => {
  const current = { ...sharedMission, runtimeProtocol: 2 as const };
  const cases: Array<[Record<string, unknown>, boolean]> = [];
  for (const code of ['selector_not_found', 'selector_not_interactable']) {
    const receipt = { version: 1, ok: false, code, beforeEffect: true, profileKey: 'company-browser', sessionId: current.sessionId, principalHash: current.ownerSubjectHash };
    cases.push([receipt, true], [{ ...receipt, version: 2 }, false], [{ ...receipt, ok: true }, false], [{ ...receipt, profileKey: 'foreign-profile' }, false], [{ ...receipt, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, false], [{ ...receipt, principalHash: 'c'.repeat(64) }, false], [{ ...receipt, extra: true }, false], [{ ...receipt, beforeEffect: false }, false]);
  }
  cases.push([{ version: 1, ok: false, code: 'unknown', beforeEffect: true, profileKey: 'company-browser', sessionId: current.sessionId, principalHash: current.ownerSubjectHash }, false]);
  for (const [receipt, trusted] of cases) {
    const n = network(sharedRuntime); n.state.processResponse = { exitCode: 0, result: JSON.stringify(receipt) };
    const c = await client({ fetchImpl: n.fetchImpl });
    await assert.rejects(c.execute(sharedBinding, current, { type: 'click', selector: '#submit' }, 10, sharedBinding.ownerSubjectHash), (error: any) => trusted ? error.name === 'DaytonaBeforeEffectError' && error.code === receipt.code : error.name !== 'DaytonaBeforeEffectError');
    assert.equal(n.state.payloads.filter((p: any) => p.op === 'execute').length, 1);
  }
  const nonzero = network(sharedRuntime); nonzero.state.processResponse = { exitCode: 1, result: JSON.stringify({ version: 1, ok: false, code: 'selector_not_found' }) };
  const provider = await client({ fetchImpl: nonzero.fetchImpl });
  await assert.rejects(provider.execute(sharedBinding, current, { type: 'click', selector: '#submit' }, 10, sharedBinding.ownerSubjectHash), (error: any) => error.name !== 'DaytonaBeforeEffectError');
  const legacy = network(sharedRuntime); legacy.state.processResponse = { exitCode: 0, result: JSON.stringify(cases[0]![0]) };
  await assert.rejects((await client({ fetchImpl: legacy.fetchImpl })).execute(sharedBinding, sharedMission, { type: 'click', selector: '#submit' }, 10, sharedBinding.ownerSubjectHash), (error: any) => error.name !== 'DaytonaBeforeEffectError');
});
test('V2 upload attach busy is not a whole-action no-effect proof after staging writes', async () => {
  for (const phase of ['prepare', 'attach']) {
    const n = network(sharedRuntime), f = stagedFile(); let denied = 0;
    const c = await client({ files: f.files, fetchImpl: async (input: any, init: any) => {
      if (String(input).endsWith('/process/execute')) {
        const body = JSON.parse(String(init.body));
        if (body.command.includes('browser-dispatcher.py')) {
          const payload = JSON.parse(Buffer.from(body.command.split(' ').at(-1), 'base64url').toString());
          if (payload.upload?.phase === phase) { denied++; return Response.json({ exitCode: 0, result: JSON.stringify({ version: 1, ok: false, code: 'mission_busy', beforeEffect: true }) }); }
        }
      }
      return n.fetchImpl(input, init);
    } });
    await assert.rejects(c.execute(sharedBinding, { ...sharedMission, runtimeProtocol: 2 }, { type: 'upload', fileId: f.id, selector: '#file' }, 20, sharedBinding.ownerSubjectHash), (error: any) => phase === 'prepare' ? error.code === 'daytona_operation_busy' : error.code !== 'daytona_operation_busy');
    assert.equal(denied, 1);
    assert.equal(n.requests.some(r => r.url.includes('/files/')), phase === 'attach');
  }
});
test('promotion protocol must match both the trusted mission and exact positive helper receipt', async () => {
  const current = { ...sharedMission, runtimeProtocol: 2 as const };
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  const payload = { version: 1, profileKey: sharedBinding.profileKey, sessionId: current.sessionId, principalHash: current.ownerSubjectHash, transferId: randomUUID(), stagingId: randomUUID(), relativePath: 'notes.txt', sha256: 'a'.repeat(64), byteLength: 1 };
  const context = { signal: AbortSignal.timeout(1000), remaining: () => 10000 };
  await assert.rejects((c as any).promoteWith(context, new URL('https://proxy.daytona.test/toolbox'), sharedBinding, current, payload, current.ownerSubjectHash));
  assert.equal(n.requests.length, 0, 'missing trusted V2 marker must not reach the root helper');
  for (const legacy of [false, true]) {
    const net = network(sharedRuntime), f = stagedFile(), provider = await client({ fetchImpl: net.fetchImpl, files: f.files });
    net.state.omitPromotionProtocol = !legacy; net.state.forgePromotionProtocol = legacy;
    await assert.rejects(provider.execute(sharedBinding, legacy ? sharedMission : current, { type: 'upload', fileId: f.id, selector: '#file' }, 20, sharedBinding.ownerSubjectHash));
    assert.equal(net.state.payloads.some(p => p.upload?.phase === 'attach'), false);
  }
});
test('foreign and missing organizations cannot reach any toolbox command', async () => {
  for (const org of ['22222222-2222-2222-2222-222222222222', undefined]) {
    const n = network(); n.state.sandbox.organizationId = org as any; const c = await client({ fetchImpl: n.fetchImpl });
    await assert.rejects(c.openMission(binding, mission.sessionId));
    assert.equal(n.requests.length, 1); assert.equal(n.requests.some(r => r.init.method === 'POST'), false);
  }
});
test('open and typed execution use fixed toolbox recipes and validate exact runtime receipts', async () => {
  const n = network(); const c = await client({ fetchImpl: n.fetchImpl });
  await c.openMission(binding, mission.sessionId);
  assert.equal(n.state.payloads[0].op, 'open'); assert.equal(n.state.payloads[0].sessionId, mission.sessionId);
  assert.equal(n.state.payloads[0].principalHash, binding.ownerSubjectHash);
  const result = await c.execute(binding, mission, { type: 'type', selector: '#name', text: 'harmless $(not-a-command)' }, 10, binding.ownerSubjectHash);
  assert.equal((result as any).observation.visibleText, 'Actual fixture page');
  assert.equal(n.state.payloads.at(-1).action.text, 'harmless $(not-a-command)');
  assert.equal(n.requests.some(r => String(r.init.body).includes('harmless')), false);
  await c.releaseMission(binding, mission);
  assert.equal(n.state.payloads.at(-1).principalHash, binding.ownerSubjectHash);
  n.state.foreignReceipt = true; await assert.rejects(c.openMission(binding, mission.sessionId));
});
test('WeFunder type, select, and dialog input travel only through suppressed private process stdin', async () => {
  const n = network(), privateRequests: Array<{ url: string; init: RequestInit }> = [];
  let publicPayload: any, ready: any, submitted: any, finalReceipt: any;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/process/session')) {
      privateRequests.push({ url, init });
      if (url.endsWith('/process/session')) return Response.json({ sessionId: JSON.parse(String(init.body)).sessionId });
      if (url.endsWith('/exec')) {
        const exec = JSON.parse(String(init.body));
        assert.equal(exec.runAsync, true); assert.equal(exec.suppressInputEcho, true);
        const match = String(exec.command).match(/^sudo -n runuser -u otcbrowser -- python3 -I \/opt\/otchealth-browser\/browser-dispatcher\.py --payload ([A-Za-z0-9_-]+) --private-stdin ([a-f0-9]{32})$/);
        assert.ok(match, 'public command uses fixed private-stdin invocation');
        publicPayload = JSON.parse(Buffer.from(match[1], 'base64url').toString());
        ready = { version: 1, event: 'input_ready', nonce: match[2], sessionId: wefunderMission.sessionId, profileKey: wefunderBinding.profileKey, profilePath: wefunderBinding.profilePath, principalHash: wefunderBinding.ownerSubjectHash };
        finalReceipt = { version: 1, ok: true, profileKey: wefunderBinding.profileKey, profilePath: wefunderBinding.profilePath, sessionId: wefunderMission.sessionId, result: { inputProcessed: true, actionType: publicPayload.actionType } };
        return Response.json({ cmdId: '12345678-1234-4234-8234-123456789abc' });
      }
      if (url.endsWith('/logs')) {
        const sdkVersion = new Headers(init.headers).get('x-daytona-sdk-version');
        const output = submitted ? JSON.stringify(ready) + '\n' + JSON.stringify(finalReceipt) + '\n' : JSON.stringify(ready) + '\n';
        // Legacy combined logs can be empty while the asynchronous command starts.
        return sdkVersion === '0.224.1' ? Response.json({ output, stdout: output, stderr: '' }) : new Response('', { headers: { 'content-type': 'text/plain' } });
      }
      if (url.endsWith('/input')) { submitted = JSON.parse(JSON.parse(String(init.body)).data); return Response.json({}); }
      return Response.json({ exitCode: submitted ? 0 : null });
    }
    return n.fetchImpl(input, init);
  };
  const c = await client({ fetchImpl });
  const secret = 'private-marker-not-for-command-or-receipt';
  for (const action of [
    { type: 'type', selector: '#password', text: secret },
    { type: 'select', selector: '#security-question', value: secret },
    { type: 'dialog', accept: true, promptText: secret },
  ] as any[]) {
    submitted = undefined;
    const result = await c.execute(wefunderBinding, wefunderMission, action, 10, wefunderBinding.ownerSubjectHash) as any;
    assert.equal(result.observation, null);
    assert.equal(submitted.nonce, ready.nonce); assert.deepEqual(submitted.payload.action, action);
    assert.equal(publicPayload.op, 'execute'); assert.equal(publicPayload.runtimeProtocol, 2);
    assert.equal(publicPayload.actionType, action.type); assert.equal('action' in publicPayload, false);
    assert.equal(JSON.stringify(privateRequests.filter(r => r.url.endsWith('/exec'))).includes(secret), false);
    assert.equal(JSON.stringify(privateRequests.filter(r => r.url.endsWith('/logs'))).includes(secret), false);
  }
  assert.equal(privateRequests.filter(r => r.url.endsWith('/input')).length, 3);
});
test('WeFunder private actions refuse legacy runtime protocol before provider calls', async () => {
  const n = network(), c = await client({ fetchImpl: n.fetchImpl });
  const legacy = { ...wefunderMission }; delete (legacy as any).runtimeProtocol;
  await assert.rejects(c.execute(wefunderBinding, legacy, { type: 'type', selector: '#password', text: 'private' }, 10, wefunderBinding.ownerSubjectHash), (error: any) => error.code === 'daytona_action_unsupported');
  assert.equal(n.requests.length, 0);
});
test('WeFunder private input lost acknowledgement never resends the exact input', async () => {
  const n = network(); let inputAttempts = 0; let command = ''; let submitted: any;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/process/session')) {
      if (url.endsWith('/process/session')) return Response.json({ sessionId: JSON.parse(String(init.body)).sessionId });
      if (url.endsWith('/exec')) {
        const exec = JSON.parse(String(init.body)); command = exec.command;
        const encoded = command.match(/--payload ([A-Za-z0-9_-]+)/)?.[1]; assert.ok(encoded);
        const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString());
        const nonce = command.match(/--private-stdin ([a-f0-9]{32})$/)?.[1]; assert.ok(nonce);
        return Response.json({ cmdId: '22345678-1234-4234-8234-123456789abc', payload, nonce });
      }
      if (url.endsWith('/logs')) {
        const launch = privateRequestsLaunch;
        const ready = { version: 1, event: 'input_ready', nonce: launch.nonce, sessionId: wefunderMission.sessionId, profileKey: wefunderBinding.profileKey, profilePath: wefunderBinding.profilePath, principalHash: wefunderBinding.ownerSubjectHash };
        return Response.json({ stdout: JSON.stringify(ready) + '\n' + (submitted ? JSON.stringify({ version: 1, ok: false, code: 'provider_action_failed' }) + '\n' : '') });
      }
      if (url.endsWith('/input')) { inputAttempts++; submitted = JSON.parse(JSON.parse(String(init.body)).data); throw new Error('ack lost'); }
      return Response.json({ exitCode: submitted ? 1 : null });
    }
    return n.fetchImpl(input, init);
  };
  let privateRequestsLaunch: any;
  const wrapped: typeof fetch = async (input, init = {}) => {
    const response = await fetchImpl(input, init);
    if (String(input).endsWith('/exec')) privateRequestsLaunch = await response.clone().json();
    return response;
  };
  const c = await client({ fetchImpl: wrapped });
  const secret = 'must-never-be-replayed';
  await assert.rejects(c.execute(wefunderBinding, wefunderMission, { type: 'type', selector: '#password', text: secret }, 10, wefunderBinding.ownerSubjectHash));
  assert.equal(inputAttempts, 1);
  assert.equal(command.includes(secret), false);
  assert.equal(inputAttempts, 1, 'unknown input acknowledgement does not trigger a resend');
});
test('only exact allowlisted dispatcher failures are projected and oversized stdout has a distinct safe code', async () => {
  const n = network(), c = await client({ fetchImpl: n.fetchImpl });
  n.state.processResponse = { exitCode: 1, result: JSON.stringify({ version: 1, ok: false, code: 'provider_context_destroyed' }) };
  await assert.rejects(c.execute(binding, mission, { type: 'navigate', url: 'https://example.com/' }, 10, binding.ownerSubjectHash), (error: any) => {
    assert.equal(error.code, 'daytona_runtime_provider_context_destroyed');
    assert.doesNotMatch(error.message, /PRIVATE-DISPATCHER-TEXT/);
    return true;
  });
  assert.equal(n.requests.filter(request => request.url.endsWith('/process/execute')).length, 1);

  for (const code of ['effect_unknown', 'target_operation_failed', 'destination_forbidden']) {
    n.state.processResponse = { exitCode: 1, result: JSON.stringify({ version: 1, ok: false, code }) };
    await assert.rejects(c.execute(binding, mission, { type: 'navigate', url: 'https://example.com/' }, 10, binding.ownerSubjectHash), (error: any) => {
      assert.equal(error.code, `daytona_runtime_${code}`);
      assert.doesNotMatch(error.message, /PRIVATE-DISPATCHER-TEXT/);
      return true;
    });
    assert.equal(mission.effectUnknown, true, 'dispatcher failure diagnostics do not clear the mission uncertainty fence');
  }

  for (const envelope of [
    { version: 1, ok: false, code: 'PRIVATE-DISPATCHER-TEXT' },
    { version: 1, ok: false, code: 'destination_forbidden', extra: true },
    { version: 1, ok: false, code: 'provider_context_destroyed', extra: true },
    { version: 2, ok: false, code: 'provider_context_destroyed' },
    { version: 1, ok: true, code: 'provider_context_destroyed' },
    { version: 1, ok: false, code: 'mission_busy', beforeEffect: true },
  ]) {
    n.state.processResponse = { exitCode: 1, result: JSON.stringify(envelope) };
    await assert.rejects(c.execute(binding, mission, { type: 'navigate', url: 'https://example.com/' }, 10, binding.ownerSubjectHash), (error: any) => {
      assert.equal(error.code, 'daytona_runtime_unavailable');
      assert.doesNotMatch(error.message, /PRIVATE-DISPATCHER-TEXT/);
      assert.notEqual(error.code, 'daytona_operation_busy');
      return true;
    });
  }
  n.state.processResponse = { exitCode: 2, result: JSON.stringify({ version: 1, ok: false, code: 'destination_forbidden' }) };
  await assert.rejects(c.execute(binding, mission, { type: 'navigate', url: 'https://example.com/' }, 10, binding.ownerSubjectHash), (error: any) => error.code === 'daytona_runtime_unavailable');
  n.state.processResponse = { exitCode: 1, result: 'PRIVATE-DISPATCHER-TEXT' };
  await assert.rejects(c.execute(binding, mission, { type: 'navigate', url: 'https://example.com/' }, 10, binding.ownerSubjectHash), (error: any) => error.code === 'daytona_runtime_unavailable' && !error.message.includes('PRIVATE-DISPATCHER-TEXT'));
  n.state.processResponse = { exitCode: 0, result: 'x'.repeat(100001) };
  await assert.rejects(c.execute(binding, mission, { type: 'navigate', url: 'https://example.com/' }, 10, binding.ownerSubjectHash), (error: any) => error.code === 'daytona_runtime_output_limit');
  assert.equal(n.requests.filter(request => request.url.endsWith('/process/execute')).length, 13, 'each runtime result is one request with no retry');
});
test('one shared mission can navigate distinct public domains without a fixture-only allowlist', async () => {
  const n = network(sharedRuntime), c = await client({ fetchImpl: n.fetchImpl });
  const urls = ['https://www.linkedin.com/', 'https://wefunder.com/', 'https://www.wikipedia.org/'];
  for (const url of urls) await c.execute(sharedBinding, sharedMission, { type: 'navigate', url }, 10, sharedBinding.ownerSubjectHash);
  assert.deepEqual(n.state.payloads.map(payload => payload.action.url), urls);
  assert.ok(n.state.payloads.every(payload => payload.profileKey === 'company-browser' && payload.sessionId === sharedMission.sessionId));
});
test('tab receipts preserve exact trusted target identifiers for the existing gateway shape', async () => {
  const n = network(); n.state.pageReceipt = { selectedTargetId: 'owned-selected', createdTargetId: 'owned-new', completed: true };
  const c = await client({ fetchImpl: n.fetchImpl });
  const result = await c.execute(binding, mission, { type: 'tab_create', url: 'https://example.com/' }, 10, binding.ownerSubjectHash);
  assert.deepEqual((result as any).pageReceipt, n.state.pageReceipt);
  assert.equal((result as any).observation.title, 'Example');
  n.state.pageReceipt.createdTargetId = 'unsafe\nidentifier';
  await assert.rejects(c.execute(binding, mission, { type: 'tab_create', url: 'https://example.com/' }, 10, binding.ownerSubjectHash));
});
test('foreign mission principals, invalid actions, unsupported binary surfaces have no network effects', async () => {
  const n = network(); const c = await client({ fetchImpl: n.fetchImpl });
  for (const action of [{ type: 'shell', command: 'id' }, { type: 'navigate', url: 'file:///etc/passwd' }, { type: 'upload', selector: '#file', fileId: mission.sessionId }, { type: 'capture', request: { type: 'screenshot' } }]) await assert.rejects(c.execute(binding, mission, action as any, 10, binding.ownerSubjectHash));
  await assert.rejects(c.execute(binding, mission, { type: 'snapshot' }, 10, 'c'.repeat(64)));
  assert.equal(n.requests.length, 0);
  assert.equal(c.capabilities.checkpoint, false); assert.equal(c.capabilities.upload, false); assert.equal(c.capabilities.capture, false);
  await assert.rejects(c.checkpoint(binding)); assert.equal(n.requests.length, 0);
});
test('toolbox proxy cannot send the master credential to an unapproved origin', async () => {
  const n = network(); const c = await client({ fetchImpl: async (input: any, init: any) => String(input).endsWith('/toolbox-proxy-url') ? Response.json({ url: 'https://attacker.example/toolbox' }) : n.fetchImpl(input, init) });
  await assert.rejects(c.openMission(binding, mission.sessionId));
  assert.equal(n.requests.some(r => r.init.method === 'POST'), false);
});
test('ambiguous toolbox failures never retry and never relay provider secrets or bodies', async () => {
  const n = network(); n.state.status = 503; const c = await client({ fetchImpl: n.fetchImpl });
  await assert.rejects(c.openMission(binding, mission.sessionId), (e: any) => e.code === 'daytona_provider_unavailable' && !String(e).includes(token));
  assert.equal(n.requests.filter(r => r.init.method === 'POST').length, 1);
});
test('absolute operation deadline includes a hanging token resolver', async () => {
  const c = await client({ deadlineMs: 25, resolveApiToken: async () => new Promise<string>(() => {}) });
  const started = Date.now(); await assert.rejects(c.inspect(binding), (e: any) => e.code === 'daytona_provider_timeout');
  assert.ok(Date.now() - started < 500);
});
function stagedFile() {
  const body = Buffer.from('known public upload fixture\n'), id = randomUUID(), sha256 = createHash('sha256').update(body).digest('hex'), now = Date.now();
  const record = { id, owner: binding.owner, ownerSubjectHash: binding.ownerSubjectHash, filename: 'notes.txt', contentType: 'text/plain', byteLength: body.length, sha256, status: 'ready', expiresAt: now + 120000,
    scanReceipt: { verdict: 'clean', scanner: 'clamav', sha256, byteLength: body.length, scannedAt: now, engineVersion: '1.5.4', signatureVersion: '28154', signaturesUpdatedAt: now - 1000 } };
  const calls: any[] = [];
  return { id, body, record, calls, files: { forUpload: async (...args: any[]) => { calls.push(args); return { record, body }; } } };
}
test('transfer capabilities require concrete corresponding server-only ports', async () => {
  const f = stagedFile();
  assert.equal((await client({ files: f.files })).capabilities.upload, true);
  assert.equal((await client({ files: f.files })).capabilities.capture, false);
  const captures = { createCapture: async () => { throw new Error('unused'); } };
  assert.equal((await client({ captures })).capabilities.capture, true);
  assert.deepEqual((await client({ captures })).capabilities.captureFormats, ['png', 'pdf']);
  assert.deepEqual((await client()).capabilities.captureFormats, []);
  assert.equal((await client({ captures })).capabilities.upload, false);
  await assert.rejects(client({ files: {} })); await assert.rejects(client({ captures: {} }));
});
test('concrete upload wires cleared broker bytes through prepare, multipart, fixed sudo promotion and native attach', async () => {
  const n = network(), f = stagedFile(), c = await client({ fetchImpl: n.fetchImpl, files: f.files });
  const receipt = await c.execute(binding, mission, { type: 'upload', fileId: f.id, selector: '#actual-file' }, 20, binding.ownerSubjectHash);
  assert.deepEqual(receipt, { status: 'attached', filename: f.record.filename, contentType: f.record.contentType, byteLength: f.body.length, sha256: f.record.sha256 });
  assert.deepEqual(f.calls, [[binding.owner, f.id, binding.ownerSubjectHash]]);
  assert.deepEqual(n.state.payloads.map(p => p.op === 'promote' ? p.op : p.upload.phase), ['prepare', 'promote', 'attach']);
  const [prepare, promote, attach] = n.state.payloads;
  assert.equal(prepare.principalHash, binding.ownerSubjectHash); assert.equal(prepare.sessionId, mission.sessionId);
  assert.equal(promote.transferId, prepare.upload.transferId); assert.equal(attach.upload.transferId, prepare.upload.transferId);
  assert.equal(promote.sha256, f.record.sha256); assert.equal(promote.relativePath, 'notes.txt');
  const upload = n.requests.find(r => r.url.endsWith('/files/bulk-upload'))!;
  const form = upload.init.body as FormData;
  assert.deepEqual(Buffer.from(await (form.get('files[0].file') as Blob).arrayBuffer()), f.body);
  assert.match(String(form.get('files[0].path')), /^\/tmp\/otc-browser-upload-[a-f0-9-]{36}\/payload.bin$/);
  assert.equal(JSON.stringify(receipt).includes('/home/'), false); assert.equal(JSON.stringify(receipt).includes(token), false);
});
test('transfer rechecks current principal, mission and suppression before every subsequent effect', async () => {
  for (const mutation of ['principal', 'phase', 'suppressed', 'expired']) {
    const n = network(), f = stagedFile(), current = { ...mission }, c = await client({ fetchImpl: n.fetchImpl, files: f.files });
    n.state.afterPrepare = () => {
      if (mutation === 'principal') current.ownerSubjectHash = 'c'.repeat(64);
      if (mutation === 'phase') current.phase = 'CLOSED';
      if (mutation === 'suppressed') current.sensitiveOutputSuppressed = true;
      if (mutation === 'expired') current.expiresAt = Date.now() - 1;
    };
    await assert.rejects(c.execute(binding, current, { type: 'upload', fileId: f.id, selector: '#file' }, 20, binding.ownerSubjectHash));
    assert.equal(n.requests.some(r => r.url.includes('/files/')), false, mutation);
    assert.equal(n.state.payloads.length, 1, mutation);
  }
});
test('configured transfer ports never bypass initial caller binding or broker scan ownership', async () => {
  for (const mode of ['caller', 'record-owner', 'unscanned']) {
    const n = network(), f = stagedFile(), c = await client({ fetchImpl: n.fetchImpl, files: f.files });
    if (mode === 'record-owner') f.record.ownerSubjectHash = 'c'.repeat(64);
    if (mode === 'unscanned') delete (f.record as any).scanReceipt;
    await assert.rejects(c.execute(binding, mission, { type: 'upload', fileId: f.id, selector: '#file' }, 20, mode === 'caller' ? 'c'.repeat(64) : binding.ownerSubjectHash));
    assert.equal(n.requests.length, 0); if (mode === 'caller') assert.equal(f.calls.length, 0);
  }
});
test('upload errors and foreign promotion receipts stop without retry or native attachment', async () => {
  for (const kind of ['lost-upload', 'foreign-promote', 'foreign-origin']) {
    const n = network(), f = stagedFile(); if (kind === 'foreign-promote') n.state.promotionForeign = true;
    const c = await client({ files: f.files, fetchImpl: async (input: any, init: any) => {
      if (kind === 'foreign-origin' && String(input).endsWith('/toolbox-proxy-url')) return Response.json({ url: 'https://attacker.example/toolbox' });
      if (kind === 'lost-upload' && String(input).endsWith('/files/bulk-upload')) { await n.fetchImpl(input, init); throw new Error('PRIVATE_PROVIDER_BODY'); }
      return n.fetchImpl(input, init);
    } });
    await assert.rejects(c.execute(binding, mission, { type: 'upload', fileId: f.id, selector: '#file' }, 20, binding.ownerSubjectHash), (error: any) => !String(error).includes('PRIVATE_PROVIDER_BODY'));
    assert.equal(n.state.payloads.some(p => p.upload?.phase === 'attach'), false);
    assert.ok(n.requests.filter(r => r.url.endsWith('/files/bulk-upload')).length <= 1);
    if (kind === 'foreign-origin') assert.equal(n.requests.some(r => r.init.method === 'POST'), false);
  }
});
test('one absolute provider deadline covers broker loading and prevents late transfer effects', async () => {
  const n = network(), f = stagedFile(); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const c = await client({ deadlineMs: 20, fetchImpl: n.fetchImpl, files: { forUpload: async () => { await pending; return { record: f.record, body: f.body }; } } });
  await assert.rejects(c.execute(binding, mission, { type: 'upload', fileId: f.id, selector: '#file' }, 20, binding.ownerSubjectHash), (error: any) => error.code === 'daytona_provider_timeout');
  release(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(n.requests.length, 0);
});
test('typed PNG capture admits a 4MiB frame and returns principal-bound metadata, not encoded bytes', async () => {
  const n = network(), stores: any[] = [];
  // A synthetic structurally-approved frame tests transport boundaries only;
  // the bridge's production default performs actual binary validation.
  const png = Buffer.alloc(4 * 1024 * 1024); png.set(Buffer.from('89504e470d0a1a0a', 'hex')); png.set(Buffer.from('49454e44ae426082', 'hex'), png.length - 8);
  const sha256 = createHash('sha256').update(png).digest('hex');
  n.state.result = { capture: { contentType: 'image/png', data: png.toString('base64') } };
  const captures = { createCapture: async (...args: any[]) => { stores.push(args); return { id: 'bca_' + randomUUID(), owner: args[0], sessionId: args[1], ownerSubjectHash: args[4], contentType: args[2].contentType, byteLength: args[2].body.length, sha256: args[2].sha256, createdAt: args[3], storageKey: 'PRIVATE_STORAGE_KEY' }; } };
  const c = await client({ fetchImpl: n.fetchImpl, captures, validator: { validate: async () => ({ complete: true }) } });
  const metadata = await c.execute(binding, mission, { type: 'capture', request: { type: 'screenshot', format: 'png' } }, 20, binding.ownerSubjectHash);
  assert.equal(stores.length, 1); assert.equal(stores[0][4], binding.ownerSubjectHash); assert.deepEqual(Buffer.from(stores[0][2].body), png);
  assert.equal((metadata as any).sha256, sha256); assert.equal((metadata as any).byteLength, png.length);
  assert.equal(JSON.stringify(metadata).includes('PRIVATE_STORAGE_KEY'), false); assert.equal('capture' in metadata, false);
  const before = n.requests.length;
  for (const request of [{ type: 'pdf', landscape: 'invalid' }, { type: 'screenshot', format: 'jpeg' }]) await assert.rejects(c.execute(binding, mission, { type: 'capture', request } as any, 20, binding.ownerSubjectHash));
  assert.equal(n.requests.length, before);
  n.state.result = { url: 'https://example.com/', title: 'Example', visibleText: 'x'.repeat(140000) };
  await assert.rejects(c.execute(binding, mission, { type: 'snapshot' }, 20, binding.ownerSubjectHash));
  n.state.result = { capture: { contentType: 'image/png', data: 'A'.repeat(Math.ceil(png.length / 3) * 4 + 32769) } };
  await assert.rejects(c.execute(binding, mission, { type: 'capture', request: { type: 'screenshot' } }, 20, binding.ownerSubjectHash));
  assert.equal(stores.length, 1);
});
test('capture cannot store a foreign envelope or continue after structural validation suppresses output', async () => {
  for (const mode of ['foreign', 'suppressed-during-validation']) {
    const n = network(), current = { ...mission }; let stores = 0;
    n.state.foreignReceipt = mode === 'foreign';
    n.state.result = { capture: { contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==' } };
    const c = await client({ fetchImpl: n.fetchImpl, captures: { createCapture: async () => { stores++; throw new Error('must not store'); } }, validator: { validate: async () => { current.sensitiveOutputSuppressed = true; return { complete: true }; } } });
    await assert.rejects(c.execute(binding, current, { type: 'capture', request: { type: 'screenshot' } }, 20, binding.ownerSubjectHash)); assert.equal(stores, 0, mode);
  }
});
test('shared capture returns only the actual virtual member\'s principal-bound artifact', async () => {
  const n = network(sharedRuntime), calls: any[] = [];
  n.state.result = { capture: { contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==' } };
  const c = await client({ fetchImpl: n.fetchImpl, captures: { createCapture: async (...args: any[]) => { calls.push(args); return { id: 'bca_' + randomUUID(), owner: args[0], sessionId: args[1], ownerSubjectHash: args[4], contentType: args[2].contentType, byteLength: args[2].body.length, sha256: args[2].sha256, createdAt: args[3] }; } }, validator: { validate: async () => ({ complete: true }) } });
  const receipt = await c.execute(sharedBinding, sharedMission, { type: 'capture', request: { type: 'screenshot' } }, 20, sharedBinding.ownerSubjectHash);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], sharedBinding.owner); assert.equal(calls[0][1], sharedMission.sessionId); assert.equal(calls[0][4], sharedBinding.ownerSubjectHash);
  assert.equal(n.state.payloads.at(-1).profileKey, 'company-browser');
  assert.equal('capture' in receipt, false); assert.equal('data' in receipt, false);
});
test('typed shared PDF capture gets the bounded binary allowance and preserves verified page count and virtual ownership', async () => {
  const n = network(sharedRuntime), calls: any[] = [];
  const pdf = Buffer.alloc(4 * 1024 * 1024, 32); pdf.set(Buffer.from('%PDF-1.7\n')); pdf.set(Buffer.from('\n%%EOF'), pdf.length - 6);
  n.state.result = { capture: { contentType: 'application/pdf', data: pdf.toString('base64') } };
  const c = await client({ fetchImpl: n.fetchImpl, captures: { createCapture: async (...args: any[]) => { calls.push(args); return { id: 'bca_' + randomUUID(), owner: args[0], sessionId: args[1], ownerSubjectHash: args[4], contentType: args[2].contentType, byteLength: args[2].body.length, sha256: args[2].sha256, pageCount: args[2].pageCount, createdAt: args[3] }; } }, validator: { validate: async ({ contentType }: any) => ({ complete: contentType === 'application/pdf', pageCount: 2 }) } });
  const receipt = await c.execute(sharedBinding, sharedMission, { type: 'capture', request: { type: 'pdf', landscape: true, printBackground: false } }, 20, sharedBinding.ownerSubjectHash);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], sharedBinding.owner); assert.equal(calls[0][1], sharedMission.sessionId); assert.equal(calls[0][4], sharedBinding.ownerSubjectHash);
  assert.deepEqual(Buffer.from(calls[0][2].body), pdf);
  assert.equal((receipt as any).contentType, 'application/pdf'); assert.equal((receipt as any).pageCount, 2); assert.equal((receipt as any).byteLength, pdf.length);
  assert.deepEqual(n.state.payloads.at(-1).action, { type: 'capture', request: { type: 'pdf', landscape: true, printBackground: false } });
  assert.equal(n.state.payloads.at(-1).profileKey, 'company-browser');
  assert.equal('capture' in receipt, false); assert.equal('data' in receipt, false);
  const before = n.requests.length;
  for (const request of [{ type: 'screenshot', format: 'jpeg' }, { type: 'pdf', landscape: 'true' }, { type: 'pdf', filePath: '/tmp/forbidden.pdf' }]) await assert.rejects(c.execute(sharedBinding, sharedMission, { type: 'capture', request } as any, 20, sharedBinding.ownerSubjectHash));
  assert.equal(n.requests.length, before);
});
test('viewer operations require a trusted port and exact original grant identity', async () => {
  const missing = await client(); await assert.rejects(missing.viewerGrant(binding, 60));
  const handle = mission.sessionId; const expiry = Date.now() + 60000; const calls: string[] = [];
  const viewer = { mint: async () => { calls.push('mint'); return { url: 'https://6080-approved.proxy.daytona.works/', expiresAt: expiry, grantHandle: handle }; }, read: async () => { calls.push('read'); return { url: 'https://6080-approved.proxy.daytona.works/', expiresAt: expiry, grantHandle: handle }; }, revoke: async () => { calls.push('revoke'); return { human_input_revoked: true as const }; } };
  const c = await client({ viewer }); const grant = await c.viewerGrant(binding, 60);
  assert.equal(grant.grantHandle, handle); assert.deepEqual(await c.readViewerGrant(binding, handle), grant);
  assert.deepEqual(await c.revokeViewerGrant(binding, handle), { human_input_revoked: true }); assert.deepEqual(calls, ['mint', 'read', 'revoke']);
  viewer.read = async () => ({ ...grant, grantHandle: '22222222-2222-2222-2222-222222222222' }); await assert.rejects(c.readViewerGrant(binding, handle));
  viewer.revoke = async () => ({ human_input_revoked: false as any }); await assert.rejects(c.revokeViewerGrant(binding, handle));
});
test('concrete TypeScript requests interoperate with actual Python validation and durable mission receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daytona-client-protocol-'));
  const script = fileURLToPath(new URL('../../../tools/daytona-browser-runtime/browser-dispatcher.py', import.meta.url));
  const python = `
import importlib.util,json,pathlib,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('dispatcher',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);profile=root/'chromium';profile.mkdir(mode=0o700,exist_ok=True)
class Cdp:
 def __init__(self,_): pass
 def close(self): pass
 def command(self,method,params=None,session=None):
  params=params or {}
  if method=='Target.getTargets': return {'targetInfos':[{'type':'page','targetId':'PAGE1','url':'about:blank'}]}
  if method=='Target.getTargetInfo': return {'targetInfo':{'type':'page','title':'Actual Python protocol','url':'about:blank'}}
  if method=='Target.attachToTarget': return {'sessionId':'ATTACHED'}
  if method=='Page.getFrameTree': return {'frameTree':{'frame':{'url':'about:blank'}}}
  if method=='Accessibility.getFullAXTree': return {'nodes':[]}
  if method=='Target.createTarget': return {'targetId':'PAGE2'}
  if method=='Target.closeTarget': return {'success':True}
  if method=='DOM.getDocument': return {'root':{'nodeId':1}}
  if method=='DOM.querySelectorAll': return {'nodeIds':[2] if params.get('selector')=='#name' else []}
  if method=='DOM.querySelector': return {'nodeId':2}
  if method=='DOM.describeNode': return {'node':{'nodeId':2,'nodeName':'INPUT','attributes':['id','name','type','text']}}
  if method=='DOM.getBoxModel': return {'model':{'content':[0,0,10,0,10,10,0,10]}}
  if method=='DOM.getContentQuads': return {'quads':[[0,0,10,0,10,10,0,10]]}
  return {}
def directory(path):
 return profile if str(path).endswith('/chromium') else root
with patch.object(m,'safe_directory',side_effect=directory),patch.object(m,'verify_runtime'),patch.object(m,'Cdp',Cdp),patch.object(m,'allow_url'):
 result=m.run_payload(sys.argv[3])
 print(json.dumps(result))
 sys.exit(0 if result['ok'] else 1)
`;
  const n = network();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (!String(input).endsWith('/process/execute')) return n.fetchImpl(input, init);
    const body = JSON.parse(String(init.body)); const encoded = body.command.split(' ').at(-1);
    const result = await promisify(execFile)('python3', ['-c', python, script, directory, encoded], { timeout: 2000, maxBuffer: 131072 });
    return Response.json({ exitCode: 0, result: result.stdout.trim() });
  };
  try {
    const c = await client({ fetchImpl }); await c.openMission(binding, mission.sessionId);
    const snapshot = await c.execute(binding, mission, { type: 'snapshot' }, 10, binding.ownerSubjectHash);
    assert.equal(snapshot.observation?.title, 'Actual Python protocol');
    await c.execute(binding, mission, { type: 'type', selector: '#name', text: 'nonsecret marker' }, 10, binding.ownerSubjectHash);
    const created = await c.execute(binding, mission, { type: 'tab_create', url: 'https://example.com/' }, 10, binding.ownerSubjectHash);
    assert.equal(created.pageReceipt?.createdTargetId, 'PAGE2');
    const selected = await c.execute(binding, mission, { type: 'tab_select', targetId: 'PAGE2' }, 10, binding.ownerSubjectHash);
    assert.equal(selected.pageReceipt?.selectedTargetId, 'PAGE2');
    const closed = await c.execute(binding, mission, { type: 'tab_close', targetId: 'PAGE2' }, 10, binding.ownerSubjectHash);
    assert.equal(closed.pageReceipt?.closedTargetId, 'PAGE2');
    await c.releaseMission(binding, mission);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
