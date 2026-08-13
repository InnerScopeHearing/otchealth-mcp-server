import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Same preamble as upload.test.ts -- satisfies loadEnv()'s required vars, then configures Graph
// so driveConfigured() is true and handleGraphDriveDownload's real code paths run below.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.GRAPH_TENANT_ID ||= 'test-tenant';
process.env.GRAPH_CLIENT_ID ||= 'test-client';
process.env.GRAPH_CLIENT_SECRET ||= 'test-secret';
process.env.GRAPH_DRIVE_USER ||= 'matthew@innd.com';

const { handleGraphDriveDownload } = await import('./download.js');

// Exact-hostname check, not a substring match -- see upload.test.ts for why a naive
// `.includes('login.microsoftonline.com')` is a real CodeQL finding even in a test stub.
function isLoginMicrosoftHost(url: string): boolean {
  try {
    return new URL(url).hostname === 'login.microsoftonline.com';
  } catch {
    return false;
  }
}

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

/** A fake Graph endpoint: mints a token, answers the content GET with the given bytes/contentType. */
function stubGraph(opts: { found?: boolean; content: Buffer; contentType?: string }): typeof fetch {
  const { found = true, content, contentType = 'application/octet-stream' } = opts;
  return (async (url: string | URL) => {
    const u = String(url);
    if (isLoginMicrosoftHost(u)) {
      return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/content')) {
      if (!found) return new Response('not found', { status: 404 });
      return new Response(content, { status: 200, headers: { 'content-type': contentType } });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// --- role gating (regression) -------------------------------------------------------------------

test('a caller reading a folder outside its own role is refused, with NO network call at all', async () => {
  const NETWORK_FORBIDDEN: typeof fetch = (async (url: string | URL) => {
    throw new Error(`UNEXPECTED network call to ${String(url)}`);
  }) as typeof fetch;
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const result = await handleGraphDriveDownload({ folder: 'CLO Incoming', filename: 'x.txt' }, fakeCtx('cfo'));
    const data = result.data as { error?: string; found: boolean };
    assert.equal(data.error, 'forbidden_role_folder');
    assert.equal(data.found, false);
  });
});

// --- textual-content detection by extension (CFO P1-D, 2026-07-30) -------------------------------
// Confirmed live: uploading a .md file with content_type:"text/markdown" round-tripped as
// application/octet-stream on download -- OneDrive infers/stores the item's mimeType from the file
// EXTENSION rather than reliably honoring an arbitrary Content-Type sent on upload, so relying on
// the download response's Content-Type header ALONE to decide text-vs-binary silently mis-classifies
// a genuinely textual file as binary whenever Graph's stored/reported type is generic or wrong.

test('a .md file reported as application/octet-stream by Graph is STILL returned as text (extension fallback)', async () => {
  const text = '# Notes\n\nplain markdown content, no binary bytes here\n';
  const content = Buffer.from(text, 'utf8');
  await withStubbedFetch(stubGraph({ content, contentType: 'application/octet-stream' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'notes.md' }, fakeCtx('cfo'));
    const data = result.data as { text: string | null; base64: string | null; contentType: string | null };
    assert.equal(data.contentType, 'application/octet-stream', 'the (wrong) reported type is still surfaced as-is, unmodified');
    assert.equal(data.text, text, 'the extension fallback must still classify this as textual and return it as text');
    assert.equal(data.base64, null);
  });
});

test('a genuinely binary file with an unrecognized extension is NOT misclassified as text (no false positive)', async () => {
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]); // PNG-ish bytes
  await withStubbedFetch(stubGraph({ content, contentType: 'application/octet-stream' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'image.png' }, fakeCtx('cfo'));
    const data = result.data as { text: string | null; base64: string | null };
    assert.equal(data.text, null);
    assert.equal(data.base64, content.toString('base64'));
  });
});

test('a Graph-reported textual content-type is still honored even for an unrecognized extension (no regression)', async () => {
  const text = 'csv-shaped data, but with a made-up extension Graph nonetheless labels correctly';
  const content = Buffer.from(text, 'utf8');
  await withStubbedFetch(stubGraph({ content, contentType: 'text/csv' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'report.xyz123' }, fakeCtx('cfo'));
    const data = result.data as { text: string | null };
    assert.equal(data.text, text);
  });
});

// --- verify_sha256_only: THE round-trip integrity fix (P1-2) -------------------------------------

test('verify_sha256_only returns a matching hash and NEVER the raw content (binary)', async () => {
  const content = Buffer.alloc(210_000);
  for (let i = 0; i < content.length; i++) content[i] = i % 256;
  const expectedHash = sha256Hex(content);

  await withStubbedFetch(stubGraph({ content, contentType: 'application/pdf' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'big.pdf', verify_sha256_only: true }, fakeCtx('cfo'));
    const data = result.data as { found: boolean; sha256: string | null; text: string | null; base64: string | null; size: number | null; contentType: string | null };
    assert.equal(data.found, true);
    assert.equal(data.sha256, expectedHash);
    assert.equal(data.text, null, 'hash-only mode must never return raw text content');
    assert.equal(data.base64, null, 'hash-only mode must never return raw base64 content');
    assert.equal(data.size, content.length);
    assert.equal(data.contentType, 'application/pdf');
  });
});

test('verify_sha256_only on TEXTUAL content still hashes the exact raw bytes, not a re-encoded string', async () => {
  const text = 'the exact bytes matter, not a re-encoded copy\n'.repeat(500);
  const content = Buffer.from(text, 'utf8');
  const expectedHash = sha256Hex(content);

  await withStubbedFetch(stubGraph({ content, contentType: 'text/markdown' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'notes.md', verify_sha256_only: true }, fakeCtx('cfo'));
    const data = result.data as { sha256: string | null; text: string | null; base64: string | null };
    assert.equal(data.sha256, expectedHash);
    assert.equal(data.text, null);
    assert.equal(data.base64, null);
  });
});

test('a hash-computed-here test (kept for a fast, store-independent sanity check) -- the REAL cross-handler round trip is below', async () => {
  const content = Buffer.from('round trip me', 'utf8');
  const uploadSha256 = sha256Hex(content); // what graph_drive_upload would have returned

  await withStubbedFetch(stubGraph({ content, contentType: 'text/plain' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'roundtrip.txt', verify_sha256_only: true }, fakeCtx('cfo'));
    const data = result.data as { sha256: string | null };
    assert.equal(data.sha256, uploadSha256, 'download hash must match the upload hash for the same content');
  });
});

// --- THE ACTUAL upload/download round trip, calling BOTH real handlers -----------------------------
// Review finding, 2026-07-30: the prior version of this test only computed a hash LOCALLY and
// compared it against handleGraphDriveDownload's hash -- it never called handleGraphDriveUpload at
// all, and at the time upload.ts didn't even export a testable handler or return a sha256. Now that
// PR #176 (graph_drive_upload's sha256 + fail-loud fix) is merged and handleGraphDriveUpload is a
// real exported function, this test drives BOTH handlers against one shared, stateful Graph stub
// (upload PUT writes into an in-memory store; download GET reads back from it) so the round trip is
// genuinely end to end, not hash-math-consistent-in-theory.
test('an upload/download round trip through the REAL upload and download handlers produces identical hashes', async () => {
  const { handleGraphDriveUpload } = await import('./upload.js');
  const store = new Map<string, { content: Buffer; contentType: string }>();

  const statefulStub: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (isLoginMicrosoftHost(u)) {
      return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/content')) {
      if (init?.method === 'PUT') {
        const body = init.body;
        const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
        store.set(u, { content, contentType: 'text/plain' });
        return new Response(JSON.stringify({ id: 'driveitem-1', size: content.length }), { status: 200 });
      }
      // GET (download)
      const entry = store.get(u);
      if (!entry) return new Response('not found', { status: 404 });
      return new Response(entry.content, { status: 200, headers: { 'content-type': entry.contentType } });
    }
    if (u.includes('%24select=id') || u.includes('$select=id')) {
      return new Response('not found', { status: 404 }); // exists-check: never exists yet
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;

  await withStubbedFetch(statefulStub, async () => {
    const content = 'round trip through both real handlers, not just hash math';
    const uploadResult = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'e2e.txt', text: content }, fakeCtx('cfo', false));
    const uploadData = uploadResult.data as { executed: boolean; sha256: string | null; error?: string };
    assert.equal(uploadData.executed, true, `expected upload to succeed, got error: ${uploadData.error}`);
    assert.ok(uploadData.sha256, 'expected upload to return a sha256');

    const downloadResult = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'e2e.txt', verify_sha256_only: true }, fakeCtx('cfo'));
    const downloadData = downloadResult.data as { found: boolean; sha256: string | null };
    assert.equal(downloadData.found, true);
    assert.equal(downloadData.sha256, uploadData.sha256, 'the hash graph_drive_upload returned must match what graph_drive_download independently computes for the same file');
    assert.equal(downloadData.sha256, sha256Hex(Buffer.from(content, 'utf8')), 'and both must match an independently computed hash of the original content');
  });
});

// --- not found -------------------------------------------------------------------------------------

test('a missing file is reported as not found, with sha256 null', async () => {
  await withStubbedFetch(stubGraph({ found: false, content: Buffer.alloc(0) }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'missing.txt', verify_sha256_only: true }, fakeCtx('cfo'));
    const data = result.data as { found: boolean; sha256: string | null };
    assert.equal(data.found, false);
    assert.equal(data.sha256, null);
  });
});

// --- normal (non-hash) mode is unchanged -------------------------------------------------------

test('regression: without verify_sha256_only, content is returned inline as before and sha256 is null', async () => {
  const content = Buffer.from('plain old download', 'utf8');
  await withStubbedFetch(stubGraph({ content, contentType: 'text/plain' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'plain.txt' }, fakeCtx('cfo'));
    const data = result.data as { text: string | null; base64: string | null; sha256: string | null };
    assert.equal(data.text, 'plain old download');
    assert.equal(data.sha256, null);
  });
});
