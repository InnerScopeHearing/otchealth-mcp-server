import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { BrowserFileScanReceipt } from './file-broker.js';

type FileStatus = 'quarantined' | 'ready' | 'partial';
type BrowserFileRecord = {
  id: string;
  owner: string;
  ownerSubjectHash?: string;
  filename: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  status: FileStatus;
  expiresAt: number;
};
type BrowserFileStore = {
  put(key: string, record: BrowserFileRecord, body: Uint8Array): Promise<void>;
  get(key: string): Promise<{ record: BrowserFileRecord; body: Uint8Array } | null>;
};
type BrowserFileScanner = { scan: (input: { body: Uint8Array }) => Promise<BrowserFileScanReceipt | 'infected' | 'error'> };
type BrowserFileValidator = { validate(input: { contentType: string; body: Uint8Array }): Promise<{ complete: boolean }> };
type BrokerApi = {
  stage(owner: string, input: { filename: string; contentType: string; body: Uint8Array }, principalHash?: string): Promise<BrowserFileRecord>;
  get(owner: string, fileId: string, principalHash?: string): Promise<BrowserFileRecord>;
  verifyUpload(owner: string, fileId: string, evidence: { sha256: string; byteLength: number; completed: boolean }, principalHash?: string): Promise<{ verified: true }>;
  forUpload(owner: string, fileId: string, principalHash?: string): Promise<{ record: BrowserFileRecord; body: Uint8Array }>;
};
type BrokerConstructor = new (store: BrowserFileStore, options: { scanner?: BrowserFileScanner; validator?: BrowserFileValidator; allowValidatedText?: boolean; now?: () => number }) => BrokerApi;

const brokerPath = new URL('./file-broker.js', import.meta.url).href;
const fileBrokerApi = await import('./file-broker.js').catch((error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND' && 'url' in error && error.url === brokerPath) return undefined;
  throw error;
});
const BrowserFileBroker = fileBrokerApi?.BrowserFileBroker as BrokerConstructor | undefined;

const textBody = new TextEncoder().encode('name,value\nexample,1\n');
const sha = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');
const pngChunk = (type: string, data: number[]): number[] => [
  (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff,
  ...[...type].map((char) => char.charCodeAt(0)), ...data, 0, 0, 0, 0,
];

class MemoryFileStore implements BrowserFileStore {
  readonly rows = new Map<string, { record: BrowserFileRecord; body: Uint8Array }>();
  readonly keys: string[] = [];
  async put(key: string, record: BrowserFileRecord, body: Uint8Array): Promise<void> {
    this.keys.push(key);
    this.rows.set(key, { record: structuredClone(record), body: new Uint8Array(body) });
  }
  async get(key: string): Promise<{ record: BrowserFileRecord; body: Uint8Array } | null> {
    const row = this.rows.get(key);
    return row ? { record: structuredClone(row.record), body: new Uint8Array(row.body) } : null;
  }
}

const receipt = (body: Uint8Array, now: number): BrowserFileScanReceipt => ({ verdict: 'clean', scanner: 'clamav', sha256: sha(body), byteLength: body.byteLength, scannedAt: now, engineVersion: '1.4.3', signatureVersion: '27832', signaturesUpdatedAt: now - 1000 });
const cleanScanner: BrowserFileScanner = { scan: async ({ body }) => receipt(body, 1_800_000_000_000) };
const NO_SCANNER = Symbol('no scanner');
function broker(store = new MemoryFileStore(), scanner: BrowserFileScanner | undefined | typeof NO_SCANNER = cleanScanner, now: number | (() => number) = 1_800_000_000_000, validator?: BrowserFileValidator) {
  assert.ok(BrowserFileBroker, 'file broker capability missing');
  const nowFn = typeof now === 'function' ? now : () => now;
  const boundScanner = scanner === cleanScanner ? { scan: async ({ body }: { body: Uint8Array }) => receipt(body, nowFn()) } : scanner;
  const options = { ...(boundScanner === NO_SCANNER ? {} : { scanner: boundScanner }), ...(validator ? { validator } : {}), now: nowFn };
  return { store, broker: new BrowserFileBroker(store, options) };
}

test('stages safe CSV with actual byte hash and generated owner-bound storage key', async () => {
  const { store, broker: files } = broker();
  const result = await files.stage('cfo', { filename: 'quarterly.csv', contentType: 'text/csv', body: textBody });
  assert.equal(result.owner, 'cfo');
  assert.equal(result.filename, 'quarterly.csv');
  assert.equal(result.contentType, 'text/csv');
  assert.equal(result.byteLength, textBody.byteLength);
  assert.equal(result.sha256, sha(textBody));
  assert.equal(result.status, 'ready');
  assert.equal(result.expiresAt, 1_800_003_600_000);
  assert.match(result.id, /^[0-9a-f-]{36}$/i);
  assert.equal(store.keys.length, 1);
  assert.notEqual(store.keys[0], 'quarterly.csv');
  assert.match(store.keys[0], /cfo/);
  assert.equal('body' in result, false);
  assert.equal('path' in result, false);
});

test('staged bytes and metadata are available only to their exact OAuth connection within a lane', async () => {
  const { broker: files } = broker();
  const principal = 'a'.repeat(64);
  const staged = await files.stage('cfo', { filename: 'private.csv', contentType: 'text/csv', body: textBody }, principal);
  assert.equal(staged.ownerSubjectHash, principal);
  assert.deepEqual(await files.get('cfo', staged.id, principal), staged);
  assert.deepEqual((await files.forUpload('cfo', staged.id, principal)).body, textBody);
  const evidence = { sha256: staged.sha256, byteLength: staged.byteLength, completed: true };
  assert.deepEqual(await files.verifyUpload('cfo', staged.id, evidence, principal), { verified: true });
  for (const other of [undefined, 'b'.repeat(64)]) {
    await assert.rejects(files.get('cfo', staged.id, other), /owner|connection/i);
    await assert.rejects(files.forUpload('cfo', staged.id, other), /owner|connection/i);
    await assert.rejects(files.verifyUpload('cfo', staged.id, evidence, other), /owner|connection/i);
  }
});

test('legacy unbound file references stay legacy-only and cannot be adopted by a new OAuth connection', async () => {
  const { broker: files } = broker();
  const staged = await files.stage('cfo', { filename: 'legacy.txt', contentType: 'text/plain', body: textBody });
  assert.equal((await files.get('cfo', staged.id)).id, staged.id);
  assert.deepEqual((await files.forUpload('cfo', staged.id)).body, textBody);
  await assert.rejects(files.get('cfo', staged.id, 'a'.repeat(64)), /owner|connection/i);
  await assert.rejects(files.forUpload('cfo', staged.id, 'a'.repeat(64)), /owner|connection/i);
});

test('malformed connection hashes reject before staging and malformed persisted bindings fail closed', async () => {
  const { broker: files, store } = broker();
  for (const hash of ['', 'not-a-hash', 'g'.repeat(64)]) {
    await assert.rejects(files.stage('cfo', { filename: 'safe.txt', contentType: 'text/plain', body: textBody }, hash), /binding|connection/i);
  }
  assert.equal(store.keys.length, 0);
  const staged = await files.stage('cfo', { filename: 'safe.txt', contentType: 'text/plain', body: textBody }, 'a'.repeat(64));
  store.rows.get(store.keys[0]!)!.record.ownerSubjectHash = 'invalid-persisted-binding';
  await assert.rejects(files.forUpload('cfo', staged.id, 'a'.repeat(64)), /owner|binding|connection/i);
});

test('quarantines unsafe scan results and never reports them ready', async () => {
  const scanner: BrowserFileScanner = { scan: async () => 'infected' };
  const { broker: files } = broker(new MemoryFileStore(), scanner);
  const result = await files.stage('cfo', { filename: 'upload.txt', contentType: 'text/plain', body: textBody });
  assert.equal(result.status, 'quarantined');
});

test('scanner failures also fail closed to quarantine', async () => {
  const scanner: BrowserFileScanner = { scan: async () => { throw new Error('scanner unavailable'); } };
  const { broker: files } = broker(new MemoryFileStore(), scanner);
  const result = await files.stage('cfo', { filename: 'upload.txt', contentType: 'text/plain', body: textBody });
  assert.equal(result.status, 'quarantined');
});

test('fails closed to quarantine when no scanner is configured', async () => {
  const store = new MemoryFileStore();
  const { broker: files } = broker(store, NO_SCANNER);
  const result = await files.stage('cfo', { filename: 'upload.txt', contentType: 'text/plain', body: textBody });
  assert.equal(result.status, 'quarantined');
  assert.equal(store.rows.size, 1);
});

test('opt-in validated text is ready without claiming a scan; defaults, invalid text, and scanner denials stay fail-closed', async () => {
  const store = new MemoryFileStore();
  assert.ok(BrowserFileBroker, 'file broker capability missing');
  const files = new BrowserFileBroker(store, { allowValidatedText: true, now: () => 1_800_000_000_000 });
  const staged = await files.stage('cfo', { filename: 'quarterly.csv', contentType: 'text/csv', body: textBody });
  assert.equal(staged.status, 'ready');
  assert.equal((await files.forUpload('cfo', staged.id)).record.sha256, sha(textBody));
  await assert.rejects(files.stage('cfo', { filename: 'malformed.txt', contentType: 'text/plain', body: new Uint8Array([0xc3, 0x28]) }));
  await assert.rejects(files.stage('cfo', { filename: 'active.txt', contentType: 'text/plain', body: new TextEncoder().encode('<!doctype html>') }));

  const infected = new BrowserFileBroker(new MemoryFileStore(), { allowValidatedText: true, scanner: { scan: async () => 'infected' }, now: () => 1_800_000_000_000 });
  const quarantined = await infected.stage('cfo', { filename: 'infected.csv', contentType: 'text/csv', body: textBody });
  assert.equal(quarantined.status, 'quarantined');
  await assert.rejects(infected.forUpload('cfo', quarantined.id));
});

test('rejects traversal, hidden path components, NUL, executable and active or archive MIME types', async () => {
  const { broker: files } = broker();
  const invalid = [
    { filename: '../report.txt', contentType: 'text/plain', body: textBody },
    { filename: 'folder/report.txt', contentType: 'text/plain', body: textBody },
    { filename: 'bad\0name.txt', contentType: 'text/plain', body: textBody },
    { filename: 'payload.exe', contentType: 'application/octet-stream', body: textBody },
    { filename: 'page.html', contentType: 'text/html', body: textBody },
    { filename: 'script.js', contentType: 'text/javascript', body: textBody },
    { filename: 'archive.zip', contentType: 'application/zip', body: textBody },
  ];
  for (const input of invalid) await assert.rejects(files.stage('cfo', input));
});

test('rejects MIME and content mismatches plus embedded NUL in otherwise plain text', async () => {
  const { broker: files } = broker();
  await assert.rejects(files.stage('cfo', { filename: 'page.txt', contentType: 'text/plain', body: new TextEncoder().encode('<html>no</html>') }));
  await assert.rejects(files.stage('cfo', { filename: 'report.pdf', contentType: 'application/pdf', body: textBody }));
  await assert.rejects(files.stage('cfo', { filename: 'data.csv', contentType: 'text/csv', body: new Uint8Array([0x61, 0, 0x62]) }));
});

test('binary signatures and a clean scanner alone remain quarantined', async () => {
  const { broker: files } = broker();
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...pngChunk('IDAT', [0x78]),
    ...pngChunk('IEND', []),
  ]);
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9,
  ]);
  assert.equal((await files.stage('cfo', { filename: 'doc.pdf', contentType: 'application/pdf', body: pdf })).status, 'quarantined');
  assert.equal((await files.stage('cfo', { filename: 'image.png', contentType: 'image/png', body: png })).status, 'quarantined');
  assert.equal((await files.stage('cfo', { filename: 'image.jpg', contentType: 'image/jpeg', body: jpeg })).status, 'quarantined');
  await assert.rejects(files.stage('cfo', { filename: 'partial.jpg', contentType: 'image/jpeg', body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }));
  await assert.rejects(files.stage('cfo', { filename: 'large.txt', contentType: 'text/plain', body: new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61) }));
});

test('binary readiness requires positive validator completion and preserves valid binary bytes', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n\0%%EOF');
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...pngChunk('gAMA', [0, 0, 0, 1]),
    ...pngChunk('IDAT', [0x78]),
    ...pngChunk('IEND', []),
  ]);
  const seen: Uint8Array[] = [];
  // Synthetic completion stub: exercises the trusted adapter contract in tests only.
  const validator: BrowserFileValidator = { validate: async ({ body }) => { seen.push(new Uint8Array(body)); return { complete: true }; } };
  const { broker: files } = broker(new MemoryFileStore(), cleanScanner, 1_800_000_000_000, validator);
  assert.equal((await files.stage('cfo', { filename: 'doc.pdf', contentType: 'application/pdf', body: pdf })).status, 'ready');
  assert.equal((await files.stage('cfo', { filename: 'image.png', contentType: 'image/png', body: png })).status, 'ready');
  assert.deepEqual(seen, [pdf, png]);
});

test('missing, throwing, or negative binary validation stays quarantined', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF');
  const missing = broker();
  assert.equal((await missing.broker.stage('cfo', { filename: 'doc.pdf', contentType: 'application/pdf', body: pdf })).status, 'quarantined');
  const throwing = broker(new MemoryFileStore(), cleanScanner, 1_800_000_000_000, { validate: async () => { throw new Error('validator down'); } });
  assert.equal((await throwing.broker.stage('cfo', { filename: 'doc.pdf', contentType: 'application/pdf', body: pdf })).status, 'quarantined');
  const negative = broker(new MemoryFileStore(), cleanScanner, 1_800_000_000_000, { validate: async () => ({ complete: false }) });
  assert.equal((await negative.broker.stage('cfo', { filename: 'doc.pdf', contentType: 'application/pdf', body: pdf })).status, 'quarantined');
});

test('get is owner-bound and returns metadata without file bytes', async () => {
  const { broker: files } = broker();
  const staged = await files.stage('cfo', { filename: 'quarterly.csv', contentType: 'text/csv', body: textBody });
  await assert.rejects(files.get('coo', staged.id), /owner/i);
  const record = await files.get('cfo', staged.id);
  assert.deepEqual(record, staged);
  assert.equal('body' in record, false);
});

test('get rejects corrupted stored bytes and expired references', async () => {
  const store = new MemoryFileStore();
  let now = 1_000;
  const { broker: files } = broker(store, cleanScanner, () => now);
  const staged = await files.stage('cfo', { filename: 'quarterly.csv', contentType: 'text/csv', body: textBody });
  const key = store.keys[0]!;
  store.rows.get(key)!.body[0] ^= 0xff;
  await assert.rejects(files.get('cfo', staged.id), /integrity/i);
  store.rows.get(key)!.body = new Uint8Array(textBody);
  now = staged.expiresAt;
  await assert.rejects(files.get('cfo', staged.id), /expired/i);
});

test('verifies only a complete receipt with matching owner, hash, and byte length', async () => {
  const { broker: files } = broker();
  const staged = await files.stage('cfo', { filename: 'quarterly.csv', contentType: 'text/csv', body: textBody });
  assert.deepEqual(await files.verifyUpload('cfo', staged.id, { sha256: staged.sha256, byteLength: staged.byteLength, completed: true }), { verified: true });
  await assert.rejects(files.verifyUpload('coo', staged.id, { sha256: staged.sha256, byteLength: staged.byteLength, completed: true }), /owner/i);
  await assert.rejects(files.verifyUpload('cfo', staged.id, { sha256: staged.sha256, byteLength: staged.byteLength, completed: false }), /partial|complete/i);
  await assert.rejects(files.verifyUpload('cfo', staged.id, { sha256: '0'.repeat(64), byteLength: staged.byteLength, completed: true }), /hash|digest/i);
  await assert.rejects(files.verifyUpload('cfo', staged.id, { sha256: staged.sha256, byteLength: staged.byteLength - 1, completed: true }), /length|size|byte/i);
});

test('provider upload read returns an owner-bound verified copy only for an unexpired ready file', async () => {
  let now = 1_800_000_000_000;
  const { store, broker: files } = broker(new MemoryFileStore(), cleanScanner, () => now);
  const staged = await files.stage('cfo', { filename: 'quarterly.csv', contentType: 'text/csv', body: textBody });
  const resolved = await files.forUpload('cfo', staged.id);
  assert.deepEqual(resolved.record, staged);
  assert.deepEqual(resolved.body, textBody);
  resolved.body[0] ^= 0xff;
  assert.deepEqual((await files.forUpload('cfo', staged.id)).body, textBody, 'caller cannot mutate stored bytes through the provider port');
  await assert.rejects(files.forUpload('coo', staged.id), /owner/i);

  const quarantined = await broker(new MemoryFileStore(), { scan: async () => 'infected' }, () => now).broker.stage('cfo', { filename: 'quarantine.csv', contentType: 'text/csv', body: textBody });
  await assert.rejects(files.forUpload('cfo', quarantined.id));

  now = staged.expiresAt;
  await assert.rejects(files.forUpload('cfo', staged.id), /expired/i);
});
