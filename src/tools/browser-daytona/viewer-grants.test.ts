import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DaytonaBinding } from './contract.js';
import type { DaytonaViewerGrantRecord, DaytonaViewerGrantStore } from './viewer-grant-store.js';

const organizationId = '501db94e-10ee-4bc8-9cca-23c793c67524';
const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const apiToken = 'MASTER-SERVER-ONLY-NEVER-IN-VIEWER';
const signedToken = 'only-port-token';
const signedRoot = `https://6080-${signedToken}.proxy.daytona.test/`;
const viewerUrl = `${signedRoot}vnc.html`;
const scriptSha = '17f61b92692760ae7908a3987b593180bed0e8bf2f9a52afb1fa80d9489dcce2';

class MemoryGrants implements DaytonaViewerGrantStore {
  rows = new Map<string, DaytonaViewerGrantRecord>();
  leases = new Map<string, string>();
  failActive = false; failFinish = false; loseFinishAck = false;
  async reserve(value: DaytonaViewerGrantRecord) {
    if (this.leases.has(value.scopeHash) || this.rows.has(value.grantHandle)) return false;
    this.leases.set(value.scopeHash, value.grantHandle); this.rows.set(value.grantHandle, structuredClone(value)); return true;
  }
  async load(handle: string) { return structuredClone(this.rows.get(handle) ?? null); }
  async readPhysicalScope(scopeHash: string) { return this.leases.get(scopeHash) ?? null; }
  async compareAndSwap(before: DaytonaViewerGrantRecord, after: DaytonaViewerGrantRecord) {
    if (JSON.stringify(this.rows.get(before.grantHandle)) !== JSON.stringify(before)) return false;
    if (this.failActive && after.phase === 'ACTIVE' || this.failFinish && after.phase === 'REVOKED') throw new Error(`${apiToken} ${viewerUrl}`);
    this.rows.set(before.grantHandle, structuredClone(after));
    if (after.phase === 'REVOKED' && this.leases.get(before.scopeHash) === before.grantHandle) this.leases.delete(before.scopeHash);
    if (this.loseFinishAck && after.phase === 'REVOKED') throw new Error('lost committed terminal acknowledgement');
    return true;
  }
}
function network(store: MemoryGrants) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const state = { public: false, organizationId, sandboxId: binding.sandboxId, started: true, expireStatus: 200, negativeStatus: 403, baselineStatus: 200, expired: false, nativeExit: 0, nativeClients: 0, nativePid: 321, nativeRevoked: true, proxy: 'https://toolbox.daytona.test/toolbox', mintFailure: false, mintDelayMs: 0, expireDelayMs: 0, scriptSha, mintResult: {} as Record<string, unknown> };
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    assert.equal(init.redirect, 'manual'); assert.equal(init.signal?.aborted, false);
    if (url === viewerUrl) {
      assert.equal(new Headers(init.headers).get('authorization'), null); assert.equal(init.credentials, 'omit');
      return new Response('', { status: state.expired ? state.negativeStatus : state.baselineStatus });
    }
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${apiToken}`);
    if (url.endsWith('/signed-preview-url?expiresInSeconds=60')) {
      assert.equal([...store.rows.values()].at(-1)?.phase, 'MINTING', 'durable fence must precede effectful mint');
      if (state.mintDelayMs) await new Promise(resolve => setTimeout(resolve, state.mintDelayMs));
      if (state.mintFailure) throw new Error(`${apiToken} ${viewerUrl}`);
      return Response.json({ sandboxId: binding.sandboxId, port: 6080, token: signedToken, url: signedRoot, ...state.mintResult });
    }
    if (url.endsWith(`/signed-preview-url/${signedToken}/expire`)) {
      assert.equal([...store.rows.values()].at(-1)?.phase, 'REVOKING', 'durable fence must precede revoke');
      assert.equal(init.method, 'POST'); assert.equal(init.body, undefined); state.expired = true;
      if (state.expireDelayMs) await new Promise(resolve => setTimeout(resolve, state.expireDelayMs));
      return new Response('', { status: state.expireStatus });
    }
    if (url.endsWith('/toolbox-proxy-url')) return Response.json({ url: state.proxy });
    if (url.endsWith('/process/execute')) {
      assert.equal(state.expired, true); assert.ok([401, 403].includes(state.negativeStatus));
      const body = JSON.parse(String(init.body)) as { command: string; timeout: number };
      assert.match(body.command, /^sudo -n python3 -I -c '[^']+'$/); assert.ok(body.command.includes(state.scriptSha));
      assert.ok(body.command.includes('/opt/otchealth-browser/viewer_control.py'));
      assert.ok(body.command.indexOf('sha256') < body.command.indexOf('exec(compile'));
      assert.ok(body.command.includes('sys.argv=[str(p),"disconnect"]'));
      assert.ok(body.timeout >= 1 && body.timeout <= 12);
      return Response.json({ exitCode: state.nativeExit, result: JSON.stringify({ human_input_revoked: state.nativeRevoked, display: ':0', active_clients: state.nativeClients, x11vnc_pid: state.nativePid }) });
    }
    assert.equal(url, 'https://app.daytona.test/api/sandbox/sandbox-one');
    return Response.json({ id: state.sandboxId, organizationId: state.organizationId, state: state.started ? 'started' : 'stopped', public: state.public });
  };
  return { calls, state, fetchImpl };
}
async function fixture(overrides: Record<string, unknown> = {}) {
  const module = await import('./viewer-grants.js').catch(() => null);
  assert.equal(typeof module?.EncryptedDaytonaViewerGrantPort, 'function', 'private encrypted viewer grant port is missing');
  const store = new MemoryGrants(); const net = network(store); const encryptionKey = randomBytes(32);
  const options = { store, apiBaseUrl: 'https://app.daytona.test/api', organizationId, resolveApiToken: async () => apiToken, encryptionKey, previewDomain: 'proxy.daytona.test', previewPort: 6080, previewPath: '/vnc.html', viewerControlSha256: scriptSha, toolboxAllowedOrigins: ['https://toolbox.daytona.test'], fetchImpl: net.fetchImpl, ...overrides };
  const port = new module!.EncryptedDaytonaViewerGrantPort(options);
  return { port, store, net, options, module: module! };
}

test('official scoped mint is fenced before effects, encrypted at rest, and reload reuses exactly one original grant', async () => {
  const { port, store, net } = await fixture(); const started = Date.now();
  const value = await port.mint(binding, 60);
  assert.equal(value.url, viewerUrl); assert.match(value.grantHandle, /^[a-f0-9-]{36}$/);
  assert.ok(value.expiresAt >= started + 59000 && value.expiresAt <= Date.now() + 60000);
  const persisted = JSON.stringify([...store.rows]);
  for (const secret of [apiToken, signedToken, viewerUrl, signedRoot]) assert.equal(persisted.includes(secret), false);
  // Explicit approved NONSECRET enrollment metadata supports restart cleanup;
  // token/URL/credential fields remain forbidden by the strict record codec.
  const stored = [...store.rows.values()][0]!;
  assert.deepEqual(stored.binding, binding); assert.equal(stored.organizationId, organizationId); assert.equal(stored.version, 2);
  assert.deepEqual(Object.keys(stored).sort(), ['version', 'organizationId', 'binding', 'grantHandle', 'bindingHash', 'scopeHash', 'expiresAt', 'phase', 'sealed'].sort());
  assert.equal([...store.rows.values()][0]?.phase, 'ACTIVE');
  assert.deepEqual(await port.read(binding, value.grantHandle), value);
  assert.deepEqual(await port.read(binding, value.grantHandle), value);
  assert.equal(net.calls.filter(c => c.url.includes('?expiresInSeconds=')).length, 1);
  await assert.rejects(port.mint(binding, 60));
  assert.equal(net.calls.filter(c => c.url.includes('?expiresInSeconds=')).length, 1);
});
test('revoke requires exact provider ACK, old signed URL denial, then SHA-pinned native same-process zero-client proof', async () => {
  const { port, store, net } = await fixture(); const grant = await port.mint(binding, 60); net.calls.length = 0;
  assert.deepEqual(await port.revoke(binding, grant.grantHandle), { human_input_revoked: true });
  assert.deepEqual(net.calls.map(call => new URL(call.url).pathname), ['/api/sandbox/sandbox-one', `/api/sandbox/sandbox-one/ports/6080/signed-preview-url/${signedToken}/expire`, '/vnc.html', '/api/sandbox/sandbox-one/toolbox-proxy-url', '/toolbox/sandbox-one/process/execute']);
  assert.equal(store.rows.get(grant.grantHandle)?.phase, 'REVOKED'); assert.equal(store.leases.size, 0);
  assert.equal(store.rows.get(grant.grantHandle)?.sealed, undefined);
  const count = net.calls.length; assert.deepEqual(await port.revoke(binding, grant.grantHandle), { human_input_revoked: true }); assert.equal(net.calls.length, count);
  await assert.rejects(port.read(binding, grant.grantHandle));
});
test('foreign OAuth subject, owner, profile, sandbox, org or ciphertext cannot decrypt or revoke another grant', async () => {
  const { port, store, net, options, module } = await fixture(); const grant = await port.mint(binding, 60); net.calls.length = 0;
  for (const foreign of [{ ...binding, ownerSubjectHash: 'c'.repeat(64) }, { ...binding, owner: 'cfo' }, { ...binding, sandboxId: 'foreign' }, { ...binding, profileKey: 'other', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/other/chromium' }]) {
    await assert.rejects(port.read(foreign, grant.grantHandle)); await assert.rejects(port.revoke(foreign, grant.grantHandle));
  }
  const otherOrg = new module.EncryptedDaytonaViewerGrantPort({ ...options, organizationId: '22222222-2222-4222-8222-222222222222' });
  await assert.rejects(otherOrg.read(binding, grant.grantHandle)); assert.equal(net.calls.length, 0);
  const row = store.rows.get(grant.grantHandle)!; assert.ok(row.sealed); row.sealed.ciphertext = `${row.sealed.ciphertext[0] === 'A' ? 'B' : 'A'}${row.sealed.ciphertext.slice(1)}`;
  await assert.rejects(port.read(binding, grant.grantHandle)); await assert.rejects(port.revoke(binding, grant.grantHandle)); assert.equal(net.calls.length, 0);
});
test('original expiry is immutable and expiration never discards revocation capability or physical display fence', async () => {
  let now = Date.now(); const { port, store, net } = await fixture({ now: () => now }); const grant = await port.mint(binding, 60);
  now = grant.expiresAt; await assert.rejects(port.read(binding, grant.grantHandle)); await assert.rejects(port.mint(binding, 60));
  assert.equal(store.leases.size, 1); assert.equal(net.calls.filter(c => c.url.includes('?expiresInSeconds=')).length, 1);
  assert.deepEqual(await port.revoke(binding, grant.grantHandle), { human_input_revoked: true });
});
test('invalid TTL, key, endpoint, path and script config fail before any network or mint', async () => {
  const { port, net, options, module } = await fixture();
  for (const ttl of [0, 301, 86400, 1.5, NaN]) await assert.rejects(port.mint(binding, ttl));
  assert.equal(net.calls.length, 0);
  for (const bad of [{ encryptionKey: Buffer.alloc(32) }, { encryptionKey: randomBytes(16) }, { viewerControlSha256: 'not-a-pin' }, { apiBaseUrl: 'http://api.test/' }, { previewPath: '/vnc.html?token=secret' }, { previewDomain: 'proxy.test.evil/' }, { toolboxAllowedOrigins: ['https://proxy.test/path'] }]) assert.throws(() => new module.EncryptedDaytonaViewerGrantPort({ ...options, ...bad }));
});
test('private started sandbox and exact organization are checked before mint', async () => {
  for (const field of ['public', 'organizationId', 'sandboxId', 'started'] as const) {
    const { port, net } = await fixture();
    if (field === 'public') net.state.public = true; else if (field === 'started') net.state.started = false; else net.state[field] = 'foreign';
    await assert.rejects(port.mint(binding, 60)); assert.equal(net.calls.some(c => c.url.includes('signed-preview-url')), false);
  }
});
test('ambiguous mint and failed activation retain permanent fence, disclose no secrets and are never retried', async () => {
  for (const mode of ['provider', 'storage'] as const) {
    const { port, store, net } = await fixture(); net.state.mintFailure = mode === 'provider'; store.failActive = mode === 'storage';
    await assert.rejects(port.mint(binding, 60), e => !String(e).includes(apiToken) && !String(e).includes(signedToken));
    assert.equal([...store.rows.values()][0]?.phase, 'MINTING'); assert.equal(store.leases.size, 1);
    await assert.rejects(port.mint(binding, 60)); assert.equal(net.calls.filter(c => c.url.includes('?expiresInSeconds=')).length, 1);
  }
});
test('only 401/403 old-token denial is positive: 200, redirect, 404, 429, 5xx and unknown native proof remain fenced', async () => {
  for (const status of [200, 302, 404, 429, 500, 503]) {
    const { port, store, net } = await fixture(); const grant = await port.mint(binding, 60); net.state.negativeStatus = status;
    await assert.rejects(port.revoke(binding, grant.grantHandle)); assert.equal(store.rows.get(grant.grantHandle)?.phase, 'REVOKING'); assert.equal(store.leases.size, 1);
    assert.equal(net.calls.some(c => c.url.endsWith('/process/execute')), false);
    const count = net.calls.length; await assert.rejects(port.revoke(binding, grant.grantHandle)); assert.equal(net.calls.length, count);
  }
  for (const receipt of [{ nativeExit: 1 }, { nativeClients: 1 }, { nativePid: 0 }, { nativeRevoked: false }, { proxy: 'https://untrusted.test/toolbox' }]) {
    const { port, store, net } = await fixture(); const grant = await port.mint(binding, 60); Object.assign(net.state, receipt);
    await assert.rejects(port.revoke(binding, grant.grantHandle)); assert.equal(store.rows.get(grant.grantHandle)?.phase, 'REVOKING'); assert.equal(store.leases.size, 1);
  }
});
test('expire non-200 ACK, including 204, cannot run native disconnect or report success', async () => {
  for (const status of [204, 401, 403, 500]) {
    const { port, store, net } = await fixture(); const grant = await port.mint(binding, 60); net.state.expireStatus = status;
    await assert.rejects(port.revoke(binding, grant.grantHandle)); assert.equal(store.rows.get(grant.grantHandle)?.phase, 'REVOKING'); assert.equal(net.calls.some(c => c.url.endsWith('/process/execute')), false);
  }
});
test('lost terminal storage ACK never fabricates success; committed positive receipt is safely readable later', async () => {
  for (const committed of [false, true]) {
    const { port, store, net } = await fixture(); const grant = await port.mint(binding, 60); store.failFinish = !committed; store.loseFinishAck = committed;
    await assert.rejects(port.revoke(binding, grant.grantHandle)); const count = net.calls.length;
    if (committed) assert.deepEqual(await port.revoke(binding, grant.grantHandle), { human_input_revoked: true }); else await assert.rejects(port.revoke(binding, grant.grantHandle));
    assert.equal(net.calls.length, count); assert.equal(store.leases.size, committed ? 0 : 1);
  }
});
test('one physical sandbox cannot receive concurrent profile grants and ambiguous revocation never unlocks it', async () => {
  const { port, store, net } = await fixture();
  const other = { ...binding, owner: 'cfo', ownerSubjectHash: 'd'.repeat(64), profileKey: 'other', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/other/chromium' };
  const values = await Promise.allSettled([port.mint(binding, 60), port.mint(other, 60)]);
  assert.equal(values.filter(v => v.status === 'fulfilled').length, 1); assert.equal(store.rows.size, 1);
  assert.equal(net.calls.filter(c => c.url.includes('?expiresInSeconds=')).length, 1);
});
test('absolute timeout fences slow mint and prevents late activation or automatic second provider call', async () => {
  const { port, store, net } = await fixture({ deadlineMs: 20 }); net.state.mintDelayMs = 50;
  await assert.rejects(port.mint(binding, 60)); await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal([...store.rows.values()][0]?.phase, 'MINTING'); assert.equal(store.leases.size, 1);
  assert.equal(net.calls.length, 2);
});
test('native SHA pin cannot be bypassed by Python optimization and executes exactly the verified bytes', async () => {
  const source = 'import json;print(json.dumps({"human_input_revoked":True,"display":":0","active_clients":0,"x11vnc_pid":321}))';
  const expectedSha = createHash('sha256').update(source).digest('hex');
  const { port, net } = await fixture({ viewerControlSha256: expectedSha }); net.state.scriptSha = expectedSha;
  const grant = await port.mint(binding, 60); await port.revoke(binding, grant.grantHandle);
  const request = net.calls.find(call => call.url.endsWith('/process/execute'))!;
  const command = (JSON.parse(String(request.init.body)) as { command: string }).command;
  const code = /^sudo -n python3 -I -c '([^']+)'$/.exec(command)![1]!;
  const driver = `
import base64,pathlib,sys
from unittest.mock import patch
source=base64.b64decode(sys.argv[2]) if sys.argv[2]!='tampered' else b'print("UNPINNED-RAN")'
with patch.object(pathlib.Path,'read_bytes',return_value=source):
 exec(sys.argv[1],{})
`;
  const python = promisify(execFile);
  const good = await python('python3', ['-c', driver, code, Buffer.from(source).toString('base64')], { timeout: 2000, maxBuffer: 4096 });
  assert.deepEqual(JSON.parse(good.stdout), { human_input_revoked: true, display: ':0', active_clients: 0, x11vnc_pid: 321 });
  await assert.rejects(python('python3', ['-c', driver, code, 'tampered'], { env: { ...process.env, PYTHONOPTIMIZE: '1' }, timeout: 2000, maxBuffer: 4096 }));
});
test('foreign or malformed SDK signed grants cannot become ACTIVE or receive the master key', async () => {
  for (const result of [{ sandboxId: 'foreign' }, { port: 22222 }, { token: 'foreign-token' }, { url: 'https://unapproved.example/' }, { url: `${signedRoot}?token=secret` }, { url: `${signedRoot}vnc.html` }, { token: '../unsafe' }, { url: `http://6080-${signedToken}.proxy.daytona.test/` }]) {
    const { port, store, net } = await fixture(); net.state.mintResult = result;
    await assert.rejects(port.mint(binding, 60)); assert.equal([...store.rows.values()][0]?.phase, 'MINTING'); assert.equal(store.leases.size, 1);
    assert.equal(net.calls.length, 2);
  }
});
test('a pre-existing viewer 401/403/redirect cannot become a false revocation baseline', async () => {
  for (const status of [401, 403, 302, 404, 503]) {
    const { port, store, net } = await fixture(); net.state.baselineStatus = status;
    await assert.rejects(port.mint(binding, 60)); assert.equal([...store.rows.values()][0]?.phase, 'MINTING'); assert.equal(store.leases.size, 1);
    assert.equal(net.calls.filter(call => call.url.endsWith('/process/execute')).length, 0);
  }
});
test('concurrent revokes issue exactly one expire and native disconnect, with either supported negative status', async () => {
  for (const status of [401, 403]) {
    const { port, net } = await fixture(); const grant = await port.mint(binding, 60); net.state.negativeStatus = status;
    const results = await Promise.allSettled([port.revoke(binding, grant.grantHandle), port.revoke(binding, grant.grantHandle)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(net.calls.filter(call => call.url.endsWith('/expire')).length, 1);
    assert.equal(net.calls.filter(call => call.url.endsWith('/process/execute')).length, 1);
  }
});
test('AES-GCM binds original expiry and rejects a wrong dedicated key even when row ownership hashes match', async () => {
  const { port, store, options, module, net } = await fixture(); const grant = await port.mint(binding, 60); net.calls.length = 0;
  const wrongKey = new module.EncryptedDaytonaViewerGrantPort({ ...options, encryptionKey: randomBytes(32) });
  await assert.rejects(wrongKey.read(binding, grant.grantHandle));
  const row = store.rows.get(grant.grantHandle)!; row.expiresAt += 1000;
  await assert.rejects(port.read(binding, grant.grantHandle)); await assert.rejects(port.revoke(binding, grant.grantHandle));
  assert.equal(net.calls.length, 0);
});
test('watchdog cancellation before or during revoke cannot launch late provider effects or discard durable unknown fencing', async () => {
  const { port, net, store } = await fixture(); const grant = await port.mint(binding, 60); net.calls.length = 0;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(port.revoke(binding, grant.grantHandle, cancelled.signal));
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(net.calls.length, 0); assert.equal(store.rows.get(grant.grantHandle)?.phase, 'ACTIVE');
});
test('real expiry controller drives real vault CAS/full revoke once without any URL or ticket lifetime extension', async () => {
  const { DaytonaViewerExpiryController } = await import('./viewer-expiry.js'); let now = Date.now();
  const { port, net, store } = await fixture({ now: () => now }); const grant = await port.mint(binding, 60);
  const controller = new DaytonaViewerExpiryController({ store, port, organizationId, sandboxId: binding.sandboxId, now: () => now });
  assert.equal(controller.ready(), false); assert.deepEqual(await controller.tick(), { status: 'active' });
  now = grant.expiresAt;
  assert.deepEqual(await controller.tick(), { status: 'expired_revoked' }); assert.equal(controller.ready(), true);
  assert.equal(store.rows.get(grant.grantHandle)?.expiresAt, grant.expiresAt); assert.equal(store.leases.size, 0);
  assert.deepEqual(await controller.tick(), { status: 'idle' });
  assert.equal(net.calls.filter(call => call.url.endsWith('/expire')).length, 1); assert.equal(net.calls.filter(call => call.url.endsWith('/process/execute')).length, 1);
});
test('watchdog deadline aborts concrete vault after ambiguous expire ACK and future ticks never replay unknown provider effects', async () => {
  const { DaytonaViewerExpiryController } = await import('./viewer-expiry.js'); let now = Date.now();
  const { port, net, store } = await fixture({ now: () => now }); const grant = await port.mint(binding, 60);
  now = grant.expiresAt; net.state.expireDelayMs = 60;
  const controller = new DaytonaViewerExpiryController({ store, port, organizationId, sandboxId: binding.sandboxId, now: () => now, deadlineMs: 25 });
  assert.equal((await controller.tick()).status, 'operator_attention'); assert.equal(controller.ready(), false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(store.rows.get(grant.grantHandle)?.phase, 'REVOKING'); assert.equal(store.leases.size, 1);
  const count = net.calls.length; assert.equal((await controller.tick()).status, 'operator_attention'); assert.equal(net.calls.length, count);
  assert.equal(net.calls.filter(call => call.url.endsWith('/expire')).length, 1); assert.equal(net.calls.some(call => call.url.endsWith('/process/execute')), false);
});
test('privileged pin wrapper ignores writable current directory and PYTHONPATH module shadowing', async () => {
  const source = 'print("PINNED-HELPER-ONLY")'; const expectedSha = createHash('sha256').update(source).digest('hex');
  const { port, net } = await fixture({ viewerControlSha256: expectedSha }); net.state.scriptSha = expectedSha;
  const grant = await port.mint(binding, 60); await port.revoke(binding, grant.grantHandle);
  const command = (JSON.parse(String(net.calls.find(call => call.url.endsWith('/process/execute'))!.init.body)) as { command: string }).command;
  const code = /^sudo -n python3 (?:-I )?-c '([^']+)'$/.exec(command)![1]!;
  const directory = await mkdtemp(join(tmpdir(), 'daytona-pin-isolation-'));
  const driver = 'import base64,pathlib,sys;from unittest.mock import patch\nsource=base64.b64decode(sys.argv[2])\nsys.modules.pop("hashlib",None)\nwith patch.object(pathlib.Path,"read_bytes",return_value=source):exec(sys.argv[1],{})';
  try {
    await writeFile(join(directory, 'hashlib.py'), 'raise RuntimeError("UNTRUSTED-MODULE-SHADOWING")\n');
    const result = await promisify(execFile)('python3', [...(command.includes('python3 -I -c') ? ['-I'] : []), '-c', driver, code, Buffer.from(source).toString('base64')], { cwd: directory, env: { ...process.env, PYTHONPATH: directory }, timeout: 2000, maxBuffer: 4096 });
    assert.equal(result.stdout.trim(), 'PINNED-HELPER-ONLY');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
