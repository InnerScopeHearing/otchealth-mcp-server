import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BrowserFileBroker, type BrowserFileScanReceipt, type BrowserFileRecord } from './file-broker.js';
const body = Buffer.from('public fixture'); const sha256 = createHash('sha256').update(body).digest('hex');
const now = 1_800_000_000_000;
const good: BrowserFileScanReceipt = { verdict: 'clean', scanner: 'clamav', sha256, byteLength: body.length, scannedAt: now, engineVersion: '1.4.3', signatureVersion: '27832', signaturesUpdatedAt: now - 1000 };
function broker(result: unknown) {
  let stored: { record: BrowserFileRecord; body: Uint8Array } | null = null;
  const files = new BrowserFileBroker({ put: async (_key, record, body) => { stored = { record: structuredClone(record), body }; }, get: async () => stored }, { allowValidatedText: true, scanner: { scan: async () => result as BrowserFileScanReceipt }, now: () => now });
  return files;
}
test('exact clean receipt is retained as metadata and old bare clean verdicts cannot promote files', async () => {
  const files = broker(good); const row = await files.stage('cto', { filename: 'safe.txt', contentType: 'text/plain', body });
  assert.equal(row.status, 'ready'); assert.deepEqual(row.scanReceipt, good);
  row.scanReceipt!.sha256 = '0'.repeat(64);
  assert.deepEqual((await files.get('cto', row.id)).scanReceipt, good);
  for (const result of ['clean', { ...good, sha256: '0'.repeat(64) }, { ...good, scannedAt: now + 1 }, { ...good, signaturesUpdatedAt: now - 49 * 3600000 }, { ...good, extra: 'must-not-become-public-metadata' }, { verdict: 'infected' }]) {
    const files = broker(result); const row = await files.stage('cto', { filename: 'safe.txt', contentType: 'text/plain', body });
    assert.equal(row.status, 'quarantined'); await assert.rejects(files.forUpload('cto', row.id));
  }
});
