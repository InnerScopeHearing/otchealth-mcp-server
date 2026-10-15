import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { BrowserFileRecord, BrowserFileStore } from '../tools/browser-cloud/file-broker.js';
import type { CloudBrowserStore } from '../tools/browser-cloud/contract.js';
import { DaytonaApiBrowserProvider } from '../tools/browser-daytona/client.js';

const env = { CLOUD_BROWSER_ENABLED: 'true', CLOUD_BROWSER_DDB_TABLE: 'browser-table', CLOUD_BROWSER_ARTIFACT_BUCKET: 'browser-artifacts', CLOUD_BROWSER_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/queue', AWS_REGION: 'us-east-1', BROWSER_FILE_CLAMAV_HOST: 'clamav.browser-security.internal', BROWSER_FILE_CLAMAV_PORT: '3310' };
const principal = 'a'.repeat(64), id = randomUUID(), sessionId = randomUUID();
const body = Buffer.from('public controlled fixture'), sha256 = createHash('sha256').update(body).digest('hex');
const record: BrowserFileRecord = { id, owner: 'cto', ownerSubjectHash: principal, filename: 'public.txt', contentType: 'text/plain', status: 'ready', byteLength: body.length, sha256, expiresAt: Date.now() + 60000, scanReceipt: { verdict: 'clean', scanner: 'clamav', sha256, byteLength: body.length, scannedAt: Date.now(), engineVersion: '1.4.3', signatureVersion: '27832', signaturesUpdatedAt: Date.now() - 1000 } };
async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const module = await import('./daytona-artifact-ports.js').catch(() => null);
  assert.equal(typeof module?.createConfiguredDaytonaArtifactPorts, 'function', 'normal configured Daytona artifact ports are missing');
  const calls: unknown[][] = [];
  const files: BrowserFileStore = { put: async () => { throw new Error('provider port may not stage'); }, get: async key => { calls.push(['get', key]); return { record: structuredClone(record), body }; } };
  const captureStore: Pick<CloudBrowserStore, 'createCapture'> = { createCapture: async (...args) => { calls.push(['capture', ...args]); return { id: `bca_${randomUUID()}`, owner: args[0], sessionId: args[1], ownerSubjectHash: args[4], contentType: args[2].contentType, byteLength: args[2].body.length, sha256: args[2].sha256, createdAt: args[3] }; } };
  const ports = module!.createConfiguredDaytonaArtifactPorts({ env: { ...env, ...overrides }, createFileStore: config => { calls.push(['file-store', config]); return files; }, createCaptureStore: (table, region) => { calls.push(['capture-store', table, region]); return captureStore; } });
  return { ports, calls };
}
test('configured real broker and immutable capture store ports are lazy and retain principal-bound validation', async () => {
  const { ports, calls } = await fixture(); assert.deepEqual(calls, []);
  assert.equal(typeof ports.files?.forUpload, 'function'); assert.equal(typeof ports.captures?.createCapture, 'function');
  const file = await ports.files!.forUpload('cto', id, principal); assert.equal(file.record.id, id); assert.deepEqual(file.body, new Uint8Array(body));
  assert.deepEqual(calls[0], ['file-store', { table: 'browser-table', bucket: 'browser-artifacts', region: 'us-east-1' }]);
  await assert.rejects(ports.files!.forUpload('cto', id, 'b'.repeat(64)));
  const metadata = await ports.captures!.createCapture('cto', sessionId, { contentType: 'image/png', body, sha256 }, 1000, principal);
  assert.equal(metadata.sessionId, sessionId); assert.equal(metadata.ownerSubjectHash, principal);
  assert.ok(calls.some(call => call[0] === 'capture-store' && call[1] === 'browser-table' && call[2] === 'us-east-1'));
  assert.equal(calls.filter(call => call[0] === 'file-store').length, 1);
});
test('disabled/partial artifact configuration never selects guessed default storage or enables binary capabilities', async () => {
  for (const invalid of [{ CLOUD_BROWSER_ENABLED: undefined }, { CLOUD_BROWSER_DDB_TABLE: undefined }, { CLOUD_BROWSER_ARTIFACT_BUCKET: undefined }, { CLOUD_BROWSER_QUEUE_URL: undefined }, { CLOUD_BROWSER_DDB_TABLE: 'bad/table' }, { AWS_REGION: 'foreign' }]) {
    const { ports, calls } = await fixture(invalid); assert.equal(ports.files, undefined); assert.equal(ports.captures, undefined); assert.deepEqual(calls, []);
  }
});
test('missing or malformed ClamAV settings disable upload only, with no unscanned fallback', async () => {
  for (const invalid of [{ BROWSER_FILE_CLAMAV_HOST: undefined }, { BROWSER_FILE_CLAMAV_HOST: 'https://public.example' }, { BROWSER_FILE_CLAMAV_PORT: '80' }, { BROWSER_FILE_CLAMAV_TIMEOUT_MS: '1' }]) {
    const { ports, calls } = await fixture(invalid); assert.equal(ports.files, undefined); assert.equal(typeof ports.captures?.createCapture, 'function'); assert.deepEqual(calls, []);
  }
});
test('actual concrete provider advertises upload/capture only when configured real server ports exist', async () => {
  const configured = await fixture();
  const provider = new DaytonaApiBrowserProvider({ apiBaseUrl: 'https://app.daytona.io/api', organizationId: '501db94e-10ee-4bc8-9cca-23c793c67524', resolveApiToken: async () => { throw new Error('constructor must not resolve credentials'); }, ...configured.ports });
  assert.equal(provider.capabilities.upload, true); assert.equal(provider.capabilities.capture, true); assert.equal(provider.capabilities.checkpoint, false); assert.deepEqual(configured.calls, []);
  const absent = await fixture({ CLOUD_BROWSER_ARTIFACT_BUCKET: undefined });
  const disabled = new DaytonaApiBrowserProvider({ apiBaseUrl: 'https://app.daytona.io/api', organizationId: '501db94e-10ee-4bc8-9cca-23c793c67524', resolveApiToken: async () => '', ...absent.ports });
  assert.equal(disabled.capabilities.upload, false); assert.equal(disabled.capabilities.capture, false);
});
