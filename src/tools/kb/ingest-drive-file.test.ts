import { test, before } from 'node:test';
import assert from 'node:assert';
// Type-only import (erased at runtime, so it does not front-run the env seeding below, which is why
// the VALUE import stays a dynamic import like get-document.test.ts's).
import type { IngestDeps } from './ingest-drive-file.js';

// Same env-seeding pattern as get-document.test.ts: loadEnv() validates the WHOLE env, so seed the
// unrelated required vars before importing anything that touches config.
before(() => {
  const required: Record<string, string> = {
    CIO_SITE_ID: 'test',
    CIO_TRACK_KEY: 'test',
    CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32),
    ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32),
  };
  for (const [k, v] of Object.entries(required)) process.env[k] ??= v;
});

const { handleKbIngestDriveFile, destPathError, MAX_INGEST_BYTES, OCR_NOTE } = await import('./ingest-drive-file.js');

// ── Stub seam ────────────────────────────────────────────────────────────────────────────────────

interface Calls {
  puts: Array<{ path: string; bytes: number; overwrite: boolean }>;
  downloads: number;
  heads: number;
}

function deps(opts: { fileBytes?: Buffer; exists?: boolean; found?: boolean } = {}) {
  const calls: Calls = { puts: [], downloads: 0, heads: 0 };
  const buf = opts.fileBytes ?? Buffer.from('%PDF-1.7 fake statement bytes');
  const d = {
    driveConfigured: () => true,
    downloadFile: async () => {
      calls.downloads++;
      return opts.found === false
        ? { found: false, contentType: null, size: null, text: null, base64: null }
        : { found: true, contentType: 'application/pdf', size: buf.length, text: null, base64: buf.toString('base64') };
    },
    fetchBlobRaw: async () => {
      calls.heads++;
      return opts.exists ? { found: true, contentType: 'application/pdf', buf: Buffer.from('old') } : { found: false, contentType: null, buf: null };
    },
    putBlobRaw: async (_a: string, _k: string, container: string, path: string, body: { base64?: string; contentType?: string }, overwrite = false) => {
      const bytes = Buffer.from(body.base64 ?? '', 'base64').length;
      calls.puts.push({ path, bytes, overwrite });
      return { path, container, bytes, contentType: body.contentType ?? 'application/octet-stream' };
    },
    env: () => ({ AZURE_CFO_STORAGE_ACCOUNT: 'otchealthcfodata', AZURE_CFO_STORAGE_KEY: 'k' }),
  };
  return { d: d as unknown as IngestDeps, calls };
}

const GOOD = {
  source_folder: 'CFO Outgoing/2026/source-drops/INND/WF-9145',
  filename: '2023-05-statement.pdf',
  dest_path: 'INND/2026-source-drops/WF-9145/2023-05-statement.pdf',
};

// ── RING: the load-bearing property ──────────────────────────────────────────────────────────────

test('RING: cto is REFUSED — a write into the MNPI store is not a side door around the read ring', async () => {
  const { d, calls } = deps();
  const res = await handleKbIngestDriveFile(GOOD, { callerAgent: 'cto', dryRun: false }, d);
  assert.equal((res.data as { error?: string }).error, 'forbidden_ring');
  assert.equal((res.data as { written: boolean }).written, false);
  assert.equal(calls.puts.length, 0, 'a refused caller must never reach the store');
  assert.equal(calls.downloads, 0, 'a refused caller must never even read the source file');
});

test('RING: developer and an unknown/empty caller are refused; cfo and exec are allowed', async () => {
  for (const lane of ['developer', '', 'iheartest']) {
    const { d } = deps();
    const res = await handleKbIngestDriveFile(GOOD, { callerAgent: lane, dryRun: false }, d);
    assert.equal((res.data as { error?: string }).error, 'forbidden_ring', `${lane || '(none)'} must be refused`);
  }
  for (const lane of ['cfo', 'exec']) {
    const { d, calls } = deps();
    const res = await handleKbIngestDriveFile(GOOD, { callerAgent: lane, dryRun: false }, d);
    assert.equal((res.data as { written: boolean }).written, true, `${lane} must be allowed`);
    assert.equal(calls.puts.length, 1);
  }
});

test('ROLE FOLDER: an exec-ring lane still cannot read ANOTHER role\'s OneDrive folder', async () => {
  // cfo is in the ring, so gate 1 passes — gate 2 (own-role folders, same rule
  // graph_drive_download applies) is what must refuse this.
  const { d, calls } = deps();
  const res = await handleKbIngestDriveFile({ ...GOOD, source_folder: 'CTO Outgoing/2026/source-drops' }, { callerAgent: 'cfo', dryRun: false }, d);
  assert.equal((res.data as { error?: string }).error, 'forbidden_role_folder');
  assert.equal(calls.downloads, 0);
});

// ── Destination path validation ──────────────────────────────────────────────────────────────────

test('dest_path: traversal, absolute, and _TEXT/ destinations are refused; a normal path is accepted', () => {
  assert.equal(destPathError('INND/2026-source-drops/WF-9145/2023-05-statement.pdf'), null);
  assert.match(destPathError('../secrets/x.pdf') ?? '', /\.\./);
  assert.match(destPathError('INND/../../etc/x.pdf') ?? '', /\.\./);
  assert.match(destPathError('/INND/x.pdf') ?? '', /must not start with "\//);
  assert.match(destPathError('_TEXT/INND/x.pdf.txt') ?? '', /docintel-ocr-sweep/);
  assert.match(destPathError('https://evil.example/x.pdf') ?? '', /container-relative/);
  assert.match(destPathError('a\\b.pdf') ?? '', /container-relative/);
  assert.notEqual(destPathError(''), null);
});

test('a bad dest_path refuses BEFORE touching either store', async () => {
  for (const bad of ['../x.pdf', '/x.pdf', '_TEXT/x.pdf.txt']) {
    const { d, calls } = deps();
    const res = await handleKbIngestDriveFile({ ...GOOD, dest_path: bad }, { callerAgent: 'cfo', dryRun: false }, d);
    assert.equal((res.data as { error?: string }).error, 'invalid_path', `"${bad}" must be refused`);
    assert.equal(calls.downloads, 0);
    assert.equal(calls.puts.length, 0);
  }
});

// ── dry_run ──────────────────────────────────────────────────────────────────────────────────────

test('dry_run: previews the planned copy and writes NOTHING', async () => {
  const { d, calls } = deps();
  const res = await handleKbIngestDriveFile(GOOD, { callerAgent: 'cfo', dryRun: true }, d);
  const data = res.data as { written: boolean; dry_run: boolean; path: string; bytes: number | null; sha256: string | null };
  assert.equal(calls.puts.length, 0, 'dry_run must never write');
  assert.equal(data.written, false);
  assert.equal(data.dry_run, true);
  assert.equal(data.path, GOOD.dest_path);
  assert.ok((data.bytes ?? 0) > 0, 'the preview still reports the real byte count');
  assert.match(data.sha256 ?? '', /^[0-9a-f]{64}$/, 'the preview still reports the real hash');
  assert.match(res.summary, /DRY RUN/);
});

// ── Overwrite guard ──────────────────────────────────────────────────────────────────────────────

test('overwrite: an existing blob is refused by default, and the refusal costs no download', async () => {
  const { d, calls } = deps({ exists: true });
  const res = await handleKbIngestDriveFile(GOOD, { callerAgent: 'cfo', dryRun: false }, d);
  assert.equal((res.data as { error?: string }).error, 'exists');
  assert.equal(calls.puts.length, 0);
  assert.equal(calls.downloads, 0, 'the existence check runs before the download so a refusal is cheap');
});

test('overwrite:true replaces an existing blob and threads overwrite through to the store helper', async () => {
  const { d, calls } = deps({ exists: true });
  const res = await handleKbIngestDriveFile({ ...GOOD, overwrite: true }, { callerAgent: 'cfo', dryRun: false }, d);
  assert.equal((res.data as { written: boolean }).written, true);
  assert.equal(calls.puts.length, 1);
  assert.equal(calls.puts[0].overwrite, true);
});

// ── Success shape + no content leakage ───────────────────────────────────────────────────────────

test('a real copy returns the dataroom coordinates, a hash, and the OCR-latency note — never contents', async () => {
  const bytes = Buffer.from('%PDF-1.7 SECRET-STATEMENT-BODY');
  const { d, calls } = deps({ fileBytes: bytes });
  const res = await handleKbIngestDriveFile(GOOD, { callerAgent: 'cfo', dryRun: false }, d);
  const data = res.data as Record<string, unknown>;
  assert.equal(data.written, true);
  assert.equal(data.index, 'finance-cfo-source-docs');
  assert.equal(data.container, 'cfo-source-docs');
  assert.equal(data.path, GOOD.dest_path);
  assert.equal(data.bytes, bytes.length);
  assert.equal(data.note, OCR_NOTE);
  assert.equal(calls.puts[0].bytes, bytes.length, 'the exact source bytes are what gets written');
  const serialized = JSON.stringify(data) + res.summary;
  assert.ok(!serialized.includes('SECRET-STATEMENT-BODY'), 'file contents must never appear in the payload or summary');
  assert.ok(!serialized.includes(bytes.toString('base64')), 'base64 contents must never appear either');
});

test('a missing source file reports not-found without writing', async () => {
  const { d, calls } = deps({ found: false });
  const res = await handleKbIngestDriveFile(GOOD, { callerAgent: 'cfo', dryRun: false }, d);
  assert.equal((res.data as { written: boolean }).written, false);
  assert.equal(calls.puts.length, 0);
  assert.match(res.summary, /No file/);
});

test('a file over the ingest cap is refused rather than buffered into the store', async () => {
  const { d, calls } = deps({ fileBytes: Buffer.alloc(MAX_INGEST_BYTES + 1, 0x41) });
  const res = await handleKbIngestDriveFile(GOOD, { callerAgent: 'cfo', dryRun: false }, d);
  assert.equal((res.data as { error?: string }).error, 'too_large');
  assert.equal(calls.puts.length, 0);
});
