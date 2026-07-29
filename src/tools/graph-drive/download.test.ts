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

test('an upload/download round trip produces IDENTICAL hashes for the same content (the actual acceptance test)', async () => {
  const content = Buffer.from('round trip me', 'utf8');
  const uploadSha256 = sha256Hex(content); // what graph_drive_upload would have returned

  await withStubbedFetch(stubGraph({ content, contentType: 'text/plain' }), async () => {
    const result = await handleGraphDriveDownload({ folder: 'CFO Incoming', filename: 'roundtrip.txt', verify_sha256_only: true }, fakeCtx('cfo'));
    const data = result.data as { sha256: string | null };
    assert.equal(data.sha256, uploadSha256, 'download hash must match the upload hash for the same content');
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
