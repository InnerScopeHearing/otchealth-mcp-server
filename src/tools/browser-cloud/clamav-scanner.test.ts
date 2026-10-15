import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, connect as connectNet } from 'node:net';
import test from 'node:test';

const api = await import('./clamav-scanner.js').catch(() => ({})) as Record<string, any>;
const now = Date.UTC(2026, 9, 15, 21, 0, 0);
const version = 'ClamAV 1.4.3/27832/Thu Oct 15 20:00:00 2026';
async function fixture(verdict: string | null, versionText: string | string[] = version) {
  const seen: Buffer[] = [];
  let versionReads = 0;
  const server = createServer(socket => {
    const chunks: Buffer[] = [];
    socket.on('data', bytes => {
      chunks.push(bytes); const data = Buffer.concat(chunks);
      if (data.subarray(0, 9).toString() === 'zVERSION\0') { socket.end(`${Array.isArray(versionText) ? versionText[versionReads++] : versionText}\0`); return; }
      if (data.subarray(0, 10).toString() !== 'zINSTREAM\0') return;
      let offset = 10; const body: Buffer[] = [];
      while (offset + 4 <= data.length) {
        const size = data.readUInt32BE(offset); offset += 4;
        if (!size) { seen.push(Buffer.concat(body)); if (verdict !== null) socket.end(`${verdict}\0`); return; }
        if (offset + size > data.length) return;
        body.push(data.subarray(offset, offset + size)); offset += size;
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { seen, close: () => new Promise<void>(resolve => server.close(() => resolve())), options: {
    host: '127.0.0.1', port: 3310, allowLoopback: true, now: () => now,
    connect: (_host: string, _port: number) => connectNet({ host: '127.0.0.1', port }),
  } };
}
test('streams exact copied bytes and returns a real protocol-bound clean/hash/time/signature receipt', async () => {
  assert.equal(typeof api.createClamAvBrowserFileScanner, 'function');
  const f = await fixture('stream: OK');
  try {
    const body = Buffer.alloc(150000, 0x61);
    const result = await api.createClamAvBrowserFileScanner(f.options).scan({ filename: 'safe.txt', contentType: 'text/plain', body });
    assert.equal(result.verdict, 'clean'); assert.equal(result.scanner, 'clamav');
    assert.equal(result.sha256, createHash('sha256').update(body).digest('hex')); assert.equal(result.byteLength, body.length);
    assert.equal(result.scannedAt, now); assert.equal(result.engineVersion, '1.4.3'); assert.equal(result.signatureVersion, '27832');
    assert.deepEqual(f.seen[0], body);
  } finally { await f.close(); }
});
test('FOUND, malformed, stale/future signatures, timeout and oversized responses never return clean', async () => {
  assert.equal(typeof api.createClamAvBrowserFileScanner, 'function');
  for (const [reply, db] of [['stream: Eicar-Test-Signature FOUND', version], ['stream: OK extra', version], ['stream: OK', 'ClamAV 1.4.3/1/Mon Oct 12 20:00:00 2026'], ['stream: OK', 'ClamAV 1.4.3/1/Fri Oct 16 20:00:00 2026'], ['x'.repeat(5000), version]]) {
    const f = await fixture(reply, db);
    try { assert.notEqual((await api.createClamAvBrowserFileScanner(f.options).scan({ filename: 'safe.txt', contentType: 'text/plain', body: Buffer.from('safe') })).verdict, 'clean'); }
    finally { await f.close(); }
  }
});
test('trusted configuration does not allow public addresses, implicit loopback, or missing configuration to bypass scanning', async () => {
  assert.equal(typeof api.createConfiguredBrowserFileScanner, 'function');
  assert.equal(api.createConfiguredBrowserFileScanner({}), undefined);
  for (const env of [{ BROWSER_FILE_CLAMAV_HOST: '8.8.8.8' }, { BROWSER_FILE_CLAMAV_HOST: '127.0.0.1' }, { BROWSER_FILE_CLAMAV_TIMEOUT_MS: '1000' }]) {
    const scanner = api.createConfiguredBrowserFileScanner(env); assert.ok(scanner);
    assert.notEqual((await scanner.scan({ filename: 'safe.txt', contentType: 'text/plain', body: Buffer.from('safe') })).verdict, 'clean');
  }
});

test('absolute timeout, signature rollover, body mutation and mixed DNS results fail closed or preserve exact original bytes', async () => {
  const stalled = await fixture(null);
  try {
    const result = await api.createClamAvBrowserFileScanner({ ...stalled.options, timeoutMs: 50 }).scan({ filename: 'safe.txt', contentType: 'text/plain', body: Buffer.from('safe') });
    assert.equal(result.verdict, 'error');
  } finally { await stalled.close(); }
  const changed = await fixture('stream: OK', [version, version.replace('27832', '27833')]);
  try { assert.equal((await api.createClamAvBrowserFileScanner(changed.options).scan({ filename: 'safe.txt', contentType: 'text/plain', body: Buffer.from('safe') })).verdict, 'error'); }
  finally { await changed.close(); }
  const stable = await fixture('stream: OK');
  try {
    const body = Buffer.from('safe'); const expected = Buffer.from(body);
    const pending = api.createClamAvBrowserFileScanner(stable.options).scan({ filename: 'safe.txt', contentType: 'text/plain', body }); body.fill(0);
    const result = await pending; assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex')); assert.deepEqual(stable.seen[0], expected);
  } finally { await stable.close(); }
  let connects = 0;
  const scanner = api.createClamAvBrowserFileScanner({ host: 'scanner.internal', lookup: async () => [{ address: '10.1.2.3', family: 4 }, { address: '8.8.8.8', family: 4 }], connect: () => { connects++; throw new Error('must not connect'); } });
  assert.equal((await scanner.scan({ filename: 'safe.txt', contentType: 'text/plain', body: Buffer.from('safe') })).verdict, 'error'); assert.equal(connects, 0);
});

test('cannot report clean after its absolute deadline even if the event loop delays the timeout callback', async () => {
  const f = await fixture('stream: OK'); let clocks = 0;
  try {
    const scanner = api.createClamAvBrowserFileScanner({ ...f.options, timeoutMs: 50, now: () => {
      if (++clocks === 2) { const until = Date.now() + 60; while (Date.now() < until) { /* trusted clock delay */ } }
      return now;
    } });
    assert.equal((await scanner.scan({ filename: 'safe.txt', contentType: 'text/plain', body: Buffer.from('safe') })).verdict, 'error');
  } finally { await f.close(); }
});
