import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CloudBrowserError, type CloudBrowserSession } from './contract.js';
import { attachStagedFileToOwnedInput, type BrowserFileCdp } from './provider-files.js';

const body = new TextEncoder().encode('name,value\nexample,1\n');
const sha256 = createHash('sha256').update(body).digest('hex');
const session: CloudBrowserSession = {
  sessionId: 'session', owner: 'cfo', profileId: 'profile', allowedHosts: ['example.test'],
  expiresAt: 2_000, actionsUsed: 0, providerSessionId: 'provider', automationEndpoint: 'wss://provider.test/stream',
  ownedTargetIds: ['owned-target'], selectedTargetId: 'owned-target',
};
const file = { id: 'file-1', owner: 'cfo', filename: 'report.csv', contentType: 'text/csv', byteLength: body.byteLength, sha256, status: 'ready' as const, expiresAt: 1_900 };

class Protocol implements BrowserFileCdp {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId: string }> = [];
  private chunks = 0;
  constructor(private readonly expected = file, private readonly expectedBody = body) {}
  async command(method: string, params: Record<string, unknown>, _timeoutMs: number, sessionId: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, sessionId });
    if (method === 'DOM.enable' || method === 'DOM.getDocument') return {};
    if (method === 'DOM.performSearch') return { searchId: 'search', resultCount: 1 };
    if (method === 'DOM.getSearchResults') return { nodeIds: [7] };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'input-object' } };
    if (method === 'Runtime.callFunctionOn') {
      const declaration = String(params.functionDeclaration);
      if (declaration.includes('this instanceof HTMLInputElement') && declaration.includes('this.isConnected')) return { result: { value: true } };
      if (declaration.includes('return []')) return { result: { objectId: 'parts-object' } };
      if (declaration.includes('this.push(bytes)')) return { result: { value: ++this.chunks } };
      if (declaration.includes('this.files = transfer.files')) return { result: { value: true } };
      if (declaration.includes('this.files && this.files[0]')) return { result: { objectId: 'file-object' } };
      if (declaration.includes('return { name:this.name, size:this.size, type:this.type }')) return { result: { value: { name: this.expected.filename, size: this.expected.byteLength, type: this.expected.contentType } } };
      if (declaration.includes('function(offset,length)')) {
        const args = params.arguments as Array<{ value: number }>;
        const offset = args[0]!.value;
        const length = args[1]!.value;
        return { result: { value: { offset, base64: Buffer.from(this.expectedBody.subarray(offset, offset + length)).toString('base64') } } };
      }
    }
    if (method === 'Runtime.releaseObject' || method === 'DOM.discardSearchResults') return {};
    throw new Error(`unexpected protocol method: ${method}`);
  }
}

test('streams broker bytes to one owned file input with fixed CDP code and verifies DOM readback', async () => {
  const cdp = new Protocol();
  const result = await attachStagedFileToOwnedInput({
    caller: 'cfo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]',
    file: { record: file, body }, cdp, timeoutMs: 1_000, now: () => 1_000,
  });
  assert.deepEqual(result, { status: 'attached', filename: 'report.csv', contentType: 'text/csv', byteLength: body.byteLength, sha256 });
  assert.equal(cdp.calls.every((call) => call.sessionId === 'page-session'), true);
  assert.equal(cdp.calls.filter((call) => call.method === 'Runtime.callFunctionOn').length, 7);
  assert.equal(cdp.calls.some((call) => /Runtime\.evaluate|Page\.navigate/.test(call.method)), false);
  assert.equal(cdp.calls.some((call) => call.method === 'Runtime.callFunctionOn' && String(call.params.functionDeclaration).includes('this.files = transfer.files')), true);
});

test('refuses a caller or target outside the active owned session before CDP', async () => {
  const cdp = new Protocol();
  await assert.rejects(attachStagedFileToOwnedInput({ caller: 'coo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: file, body }, cdp, timeoutMs: 1_000, now: () => 1_000 }), (error: unknown) => error instanceof CloudBrowserError && error.code === 'owner_forbidden');
  await assert.rejects(attachStagedFileToOwnedInput({ caller: 'cfo', session, targetId: 'other', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: file, body }, cdp, timeoutMs: 1_000, now: () => 1_000 }), (error: unknown) => error instanceof CloudBrowserError && error.code === 'target_not_owned');
  assert.equal(cdp.calls.length, 0);
});

test('rejects byte tampering and non-ready staged files before protocol access', async () => {
  const cdp = new Protocol();
  await assert.rejects(attachStagedFileToOwnedInput({ caller: 'cfo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: file, body: new Uint8Array([1]) }, cdp, timeoutMs: 1_000, now: () => 1_000 }), /integrity/i);
  await assert.rejects(attachStagedFileToOwnedInput({ caller: 'cfo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: { ...file, status: 'quarantined' }, body }, cdp, timeoutMs: 1_000, now: () => 1_000 }), /ready|cleared/i);
  assert.equal(cdp.calls.length, 0);
});

test('marks post-dispatch readback hash mismatch as uncertain rather than returning staged hash as provider evidence', async () => {
  const altered = new Uint8Array(body);
  altered[0] ^= 0xff;
  const cdp = new Protocol(file, altered);
  await assert.rejects(attachStagedFileToOwnedInput({ caller: 'cfo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: file, body }, cdp, timeoutMs: 1_000, now: () => 1_000 }), (error: unknown) => error instanceof CloudBrowserError && error.code === 'file_transfer_uncertain');
});

test('chunks a maximum-size file within bounded CDP argument payloads and rejects oversize input', async () => {
  const maxBytes = 10 * 1024 * 1024;
  const largeBody = new Uint8Array(maxBytes).fill(0x61);
  const largeRecord = { ...file, filename: 'large.txt', contentType: 'text/plain', byteLength: maxBytes, sha256: createHash('sha256').update(largeBody).digest('hex') };
  const cdp = new Protocol(largeRecord, largeBody);
  const result = await attachStagedFileToOwnedInput({ caller: 'cfo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: largeRecord, body: largeBody }, cdp, timeoutMs: 20_000, now: () => 1_000 });
  assert.equal(result.byteLength, maxBytes);
  const chunks = cdp.calls.filter((call) => call.method === 'Runtime.callFunctionOn' && String(call.params.functionDeclaration).includes('this.push(bytes)'));
  assert.equal(chunks.length, 10);
  assert.ok(chunks.every((call) => Buffer.byteLength(String((call.params.arguments as Array<{ value: string }>)[0]!.value), 'utf8') <= 1_400_000));

  const oversizeBody = new Uint8Array(maxBytes + 1).fill(0x61);
  await assert.rejects(attachStagedFileToOwnedInput({ caller: 'cfo', session, targetId: 'owned-target', pageSessionId: 'page-session', selector: 'input[type=file]', file: { record: { ...largeRecord, byteLength: oversizeBody.byteLength, sha256: createHash('sha256').update(oversizeBody).digest('hex') }, body: oversizeBody }, cdp, timeoutMs: 20_000, now: () => 1_000 }), /size/i);
  assert.equal(cdp.calls.filter((call) => call.method === 'Runtime.callFunctionOn').length, 25);
});
