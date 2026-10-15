import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfiguredBrowserFileBroker } from './cloud-browser-runtime.js';
import type { BrowserFileRecord, BrowserFileStore } from '../tools/browser-cloud/file-broker.js';

function memoryStore(): BrowserFileStore {
  const files = new Map<string, { record: BrowserFileRecord; body: Uint8Array }>();
  return { put: async (key, record, body) => { files.set(key, { record, body }); }, get: async key => files.get(key) ?? null };
}

test('production file broker factory wires configured scanner and never falls back to unscanned text on bad configuration', async () => {
  const input = { filename: 'owned.txt', contentType: 'text/plain', body: Buffer.from('public test fixture') };
  const ordinary = createConfiguredBrowserFileBroker(memoryStore(), {});
  assert.equal((await ordinary.stage('cto', input)).status, 'ready');
  for (const env of [{ BROWSER_FILE_CLAMAV_PORT: '1' }, { BROWSER_FILE_CLAMAV_HOST: 'https://foreign.example' }]) {
    const files = createConfiguredBrowserFileBroker(memoryStore(), env);
    const record = await files.stage('cto', input);
    assert.equal(record.status, 'quarantined');
    await assert.rejects(files.forUpload('cto', record.id));
  }
});
