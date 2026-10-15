import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requestContext } from '../../server/request-context.js';
import { BrowserFileBroker, type BrowserFileRecord } from '../browser-cloud/file-broker.js';
import { websitePrincipalHash } from '../browser-cloud/website-login-service.js';
import { DaytonaApiBrowserProvider } from '../browser-daytona/client.js';
import { registerCloudBrowserTools, type CloudBrowserGatewayRuntime, type DaytonaGatewayRuntime } from './index.js';

Object.assign(process.env, { CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test', PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32), N8N_WEBHOOK_SECRET: 'c'.repeat(32), CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 'test', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1/q', CLOUD_BROWSER_ARTIFACT_BUCKET: 'test', READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true' });
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
async function fixture() {
  const principal = websitePrincipalHash('cto', 'connection:own-connection'), sessionId = randomUUID();
  const binding = { provider: 'daytona' as const, owner: 'cto', ownerSubjectHash: principal, sandboxId: 'sandbox-one', profileKey: `cto-${principal}`, sharedProfileKey: 'company-browser' as const, profilePath: '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium', readinessReceiptSha256: 'b'.repeat(64) };
  const mission = { provider: 'daytona' as const, sessionId, owner: 'cto', ownerSubjectHash: principal, sandboxId: binding.sandboxId, profileKey: binding.profileKey, phase: 'ACTIVE' as const, runtimeProtocol: 2 as const, expiresAt: Date.now() + 180000, actionsUsed: 1, actionBudget: 25, effectUnknown: true };
  const rows = new Map<string, { record: BrowserFileRecord; body: Uint8Array }>(), reads: string[] = [], effects: any[] = [], uploads: Uint8Array[] = [], state = { executions: 0 };
  const broker = new BrowserFileBroker({ put: async (key, record, body) => { assert.equal(rows.has(key), false); rows.set(key, { record, body }); }, get: async key => { reads.push(key); return rows.get(key) ?? null; } }, { scanner: { scan: async input => { const now = Date.now(); return { verdict: 'clean', scanner: 'clamav', sha256: hash(input.body), byteLength: input.body.length, scannedAt: now, engineVersion: '1.5.4', signatureVersion: '28154', signaturesUpdatedAt: now - 1 }; } } });
  const files = [];
  for (const [filename, text] of [['one.txt', 'first public fixture\n'], ['two.txt', 'second public fixture\n']]) {
    const record = await broker.stage('cto', { filename: filename!, contentType: 'text/plain', body: Buffer.from(text!) }, principal);
    files.push({ fileId: record.id, relativePath: filename === 'one.txt' ? 'Docs/one.txt' : 'Docs/nested/two.txt' });
  }
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/toolbox-proxy-url')) return Response.json({ url: 'https://proxy.daytona.test/toolbox' });
    if (url.includes('/files/')) {
      effects.push(['upload', url]);
      if (init.body instanceof FormData) uploads.push(new Uint8Array(await (init.body.get('files[0].file') as Blob).arrayBuffer()));
      return Response.json({ errors: null });
    }
    if (url.endsWith('/process/execute')) {
      const command = JSON.parse(String(init.body)).command;
      const payload = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64url').toString()); effects.push(payload);
      if (command.includes('transfer-stage.py')) return Response.json({ exitCode: 0, result: JSON.stringify({ version: 1, ok: true, staged: true, profileKey: payload.profileKey, sessionId: payload.sessionId, runtimeProtocol: payload.runtimeProtocol, byteLength: payload.byteLength, sha256: payload.sha256 }) });
      assert.equal(payload.action.type, 'upload'); assert.equal(payload.upload.directory, true); assert.equal(payload.profileKey, 'company-browser'); assert.equal(payload.principalHash, principal);
      const result = payload.upload.phase === 'prepare' ? { prepared: true } : { directoryReceipt: { status: 'attached', directory: true, fileCount: payload.upload.files.length, byteLength: payload.upload.files.reduce((sum: number, file: any) => sum + file.byteLength, 0), files: payload.upload.files } };
      return Response.json({ exitCode: 0, result: JSON.stringify({ version: 1, ok: true, profileKey: payload.profileKey, profilePath: payload.profilePath, sessionId, result }) });
    }
    assert.equal(url, 'https://app.daytona.test/api/sandbox/sandbox-one');
    return Response.json({ id: binding.sandboxId, organizationId: '501db94e-10ee-4bc8-9cca-23c793c67524', state: 'started', public: false });
  };
  const provider = new DaytonaApiBrowserProvider({ apiBaseUrl: 'https://app.daytona.test/api', organizationId: '501db94e-10ee-4bc8-9cca-23c793c67524', resolveApiToken: async () => 'SYNTHETIC-SERVER-TOKEN', toolboxAllowedOrigins: ['https://proxy.daytona.test'], fetchImpl, files: broker });
  const runtime = { browser: { execute: async (_caller: string, id: string, action: any, seconds: number, subject: string) => { state.executions++; assert.equal(id, sessionId); return provider.execute(binding, mission, action, seconds, subject); } }, capabilities: { checkpoint: false, humanViewer: false }, viewers: {} } as unknown as DaytonaGatewayRuntime;
  const handlers = new Map<string, any>();
  const awsEffects: any[] = [];
  registerCloudBrowserTools({ registerTool: (name: string, _config: unknown, handler: any) => { handlers.set(name, handler); return { remove() {} }; } } as unknown as McpServer, () => 'a'.repeat(64), { browser: { execute: async (...args: any[]) => { awsEffects.push(args); return {}; } }, jobs: {}, queue: {}, artifacts: {} } as unknown as CloudBrowserGatewayRuntime, undefined, { get: async () => runtime, forSession: async id => id === sessionId ? runtime : undefined });
  const call = (action: unknown, id = sessionId, connection = 'own-connection') => requestContext.run({ callerAgent: 'cto', callerHash: 'a'.repeat(64), correlationId: 'directory-test', authKind: 'oauth', authSubject: 'client', authConnectionId: connection }, () => handlers.get('browser_cloud_session_action')({ session_id: id, action, timeout_seconds: 20, dry_run: false }));
  return { files, rows, reads, effects, uploads, awsEffects, state, call, action: { type: 'upload_directory', selector: '#folder', files }, principal };
}
test('external folder action uses immutable broker references for every file and only server-generated directory wire', async () => {
  const f = await fixture(); const result = await f.call(f.action);
  assert.deepEqual(result.structuredContent.result, { ok: true, file_status: 'attached', file_count: 2, byte_length: 43 });
  assert.deepEqual(f.reads, f.files.map(file => `browser-files/cto/${file.fileId}`));
  assert.equal(f.uploads.length, 2);
  assert.equal(f.effects.filter(effect => effect.upload?.phase === 'prepare').length, 1);
  assert.equal(f.effects.filter(effect => effect.upload?.phase === 'attach').length, 1);
  assert.deepEqual(f.uploads.map(hash), [...f.rows.values()].map(value => value.record.sha256));
  assert.equal(JSON.stringify(result).includes('Docs/'), false); assert.equal(JSON.stringify(result).includes('SYNTHETIC-SERVER-TOKEN'), false);
});
test('external folder action rejects malformed manifests, duplicate IDs, foreign principal, changed bytes, AV and total quota before remote effects', async () => {
  for (const mode of ['path', 'duplicate', 'principal', 'file-owner', 'hash', 'av', 'scan', 'basename', 'quota', 'count']) {
    const f = await fixture(); let action: any = f.action;
    const values = [...f.rows.values()];
    if (mode === 'path') action = { ...action, files: [{ ...f.files[0], relativePath: '../notes.txt' }] };
    if (mode === 'duplicate') action = { ...action, files: [f.files[0], f.files[0]] };
    if (mode === 'hash') values[1]!.body = Buffer.from('mutated bytes');
    if (mode === 'file-owner') values[1]!.record.ownerSubjectHash = 'd'.repeat(64);
    if (mode === 'av') values[1]!.record.status = 'quarantined';
    if (mode === 'scan') delete values[1]!.record.scanReceipt;
    if (mode === 'basename') action = { ...action, files: [f.files[0], { ...f.files[1], relativePath: 'Docs/nested/different.txt' }] };
    if (mode === 'count') action = { ...action, files: Array.from({ length: 33 }, (_, i) => ({ fileId: randomUUID(), relativePath: `Docs/${i}.txt` })) };
    if (mode === 'quota') for (const value of values) { value.body = Buffer.alloc(6 * 1024 * 1024, 97); value.record.byteLength = value.body.length; value.record.sha256 = hash(value.body); Object.assign(value.record.scanReceipt!, { byteLength: value.body.length, sha256: value.record.sha256 }); }
    const result = await f.call(action, undefined, mode === 'principal' ? 'foreign-connection' : 'own-connection');
    assert.ok(result.isError || result.structuredContent?.result?.error, mode); assert.equal(f.effects.length, 0, mode);
  }
});
test('folder action on AWS is rejected before provider execution', async () => {
  const f = await fixture(); const result = await f.call(f.action, randomUUID());
  assert.equal(result.structuredContent.result.error, 'directory_upload_unsupported');
  assert.equal(f.awsEffects.length, 0); assert.equal(f.effects.length, 0); assert.equal(f.reads.length, 0);
});
test('external folder ancestor-file collisions reject before broker reads or remote preparation in either order', async () => {
  for (const reverse of [false, true]) {
    const f = await fixture();
    const entries = [{ fileId: f.files[0]!.fileId, relativePath: 'Docs/one.txt' }, { fileId: f.files[1]!.fileId, relativePath: 'Docs/one.txt/two.txt' }];
    const result = await f.call({ ...f.action, files: reverse ? entries.reverse() : entries });
    assert.ok(result.isError || result.structuredContent?.result?.error);
    assert.equal(f.state.executions, 0); assert.equal(f.reads.length, 0); assert.equal(f.effects.length, 0); assert.equal(f.awsEffects.length, 0);
  }
});
