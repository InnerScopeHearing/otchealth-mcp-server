import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Same preamble as kb/openai-fetch.test.ts / openai-search.test.ts -- satisfies loadEnv()'s
// required vars, then configures Graph so driveConfigured() is true and handleGraphDriveUpload's
// real code paths (not the "unconfigured" short-circuit) run below.
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

const { handleGraphDriveUpload } = await import('./upload.js');
const { MAX_SIMPLE_UPLOAD_BYTES } = await import('../../graph/drive-client.js');

// Exact-hostname check, not a substring match (a naive `.includes('login.microsoftonline.com')`
// would also match an attacker-controlled host like "login.microsoftonline.com.evil.com" or
// "evil.com/?x=login.microsoftonline.com" -- CodeQL correctly flags that pattern even in a test
// stub; this is the same fix the fleet already standardized on for MSAL scope-string checks
// elsewhere, applied here to URL routing).
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

/** Fails the test loudly if ANY network call is made -- proves a refusal happened before Graph
 *  was ever touched. */
const NETWORK_FORBIDDEN: typeof fetch = (async (url: string | URL) => {
  throw new Error(`UNEXPECTED network call to ${String(url)} -- this call should have been refused before Graph was ever reached`);
}) as typeof fetch;

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

function bodyLength(body: unknown): number {
  if (body == null) return 0;
  if (Buffer.isBuffer(body)) return body.length;
  if (typeof body === 'string') return Buffer.byteLength(body);
  // Node's fetch (undici) hands the raw init.body straight through; in these tests it is always
  // either a Buffer (real upload) or a string (the token POST's form body), never anything else.
  return Buffer.byteLength(String(body));
}

/**
 * A fake Graph endpoint: mints a token, answers the exists-check GET, and answers the upload PUT.
 *
 * - `existsFirst`: whether the exists-check GET reports the file already present (404 otherwise).
 * - `reportedSize`: what the PUT response's `size` field should say.
 *     - `'echo'` (default): report the exact byte length of the body actually sent (the honest,
 *       "the write succeeded exactly as sent" case).
 *     - a number: report that number regardless of the real body length (simulates Graph
 *       confirming fewer, or more, bytes than were actually sent, i.e. a truncated write).
 *     - `'omit'`: omit the `size` field entirely from Graph's response (simulates a response that
 *       never confirms a byte count at all).
 */
function stubGraph(opts: { existsFirst?: boolean; reportedSize?: number | 'echo' | 'omit' } = {}): typeof fetch {
  const { existsFirst = false, reportedSize = 'echo' } = opts;
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (isLoginMicrosoftHost(u)) {
      return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/content')) {
      const sentLen = bodyLength(init?.body);
      const payload: Record<string, unknown> = { id: 'driveitem-1' };
      if (reportedSize === 'echo') payload.size = sentLen;
      else if (reportedSize !== 'omit') payload.size = reportedSize;
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (u.includes('%24select=id') || u.includes('$select=id')) {
      return existsFirst ? new Response(JSON.stringify({ id: 'existing-item' }), { status: 200 }) : new Response('not found', { status: 404 });
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// --- role gating (regression) -------------------------------------------------------------------

test('a caller writing to a folder outside its own role is refused, with NO network call at all', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const result = await handleGraphDriveUpload({ folder: 'CLO Incoming', filename: 'x.txt', text: 'hi' }, fakeCtx('cfo'));
    const data = result.data as { error?: string; executed: boolean; sha256: string | null };
    assert.equal(data.error, 'forbidden_role_folder');
    assert.equal(data.executed, false);
    assert.equal(data.sha256, null);
  });
});

// --- SIZE CEILING: files over Microsoft Graph's 250 MB simple-upload limit are refused loudly ----

test('a payload over MAX_SIMPLE_UPLOAD_BYTES is refused with file_too_large_for_simple_upload, NO network call', async () => {
  await withStubbedFetch(NETWORK_FORBIDDEN, async () => {
    const big = Buffer.alloc(MAX_SIMPLE_UPLOAD_BYTES + 1, 'a').toString('base64');
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'huge.bin', base64: big }, fakeCtx('cfo'));
    const data = result.data as { error?: string; executed: boolean; sha256: string | null };
    assert.equal(data.error, 'file_too_large_for_simple_upload');
    assert.equal(data.executed, false);
    assert.ok(data.sha256, 'the refusal still reports the sha256 of what was refused');
  });
});

// --- ACCEPTANCE TEST: 200KB text round-trips with a matching hash --------------------------------

test('ACCEPTANCE: a 200KB text file uploads successfully and the returned sha256 matches a local hash', async () => {
  const text = 'line of markdown content\n'.repeat(9000); // > 200KB
  const content = Buffer.from(text, 'utf8');
  assert.ok(content.length > 200_000, 'fixture should exceed 200KB');
  const expectedHash = sha256Hex(content);

  await withStubbedFetch(stubGraph(), async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'big.md', text }, fakeCtx('cfo'));
    const data = result.data as { executed: boolean; bytes: number | null; sha256: string | null; error?: string };
    assert.equal(data.error, undefined);
    assert.equal(data.executed, true);
    assert.equal(data.bytes, content.length);
    assert.equal(data.sha256, expectedHash);
  });
});

// --- ACCEPTANCE TEST: 200KB binary (base64) round-trips with a matching hash ----------------------

test('ACCEPTANCE: a 200KB binary payload uploads successfully and the returned sha256 matches a local hash', async () => {
  const content = Buffer.alloc(210_000);
  for (let i = 0; i < content.length; i++) content[i] = i % 256; // high-entropy-ish binary fixture
  const base64 = content.toString('base64');
  const expectedHash = sha256Hex(content);

  await withStubbedFetch(stubGraph(), async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'big.bin', base64 }, fakeCtx('cfo'));
    const data = result.data as { executed: boolean; bytes: number | null; sha256: string | null; error?: string };
    assert.equal(data.error, undefined);
    assert.equal(data.executed, true);
    assert.equal(data.bytes, content.length);
    assert.equal(data.sha256, expectedHash);
  });
});

// --- ACCEPTANCE TEST: a truncated write is refused, never reported as success --------------------

test('ACCEPTANCE: Graph confirming fewer bytes than were sent is refused as incomplete_upload, not executed:true', async () => {
  const content = Buffer.from('x'.repeat(50_000), 'utf8');
  const truncatedSize = content.length - 5; // Graph reports 5 bytes short of what was actually sent

  await withStubbedFetch(stubGraph({ reportedSize: truncatedSize }), async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'truncated.txt', text: content.toString('utf8') }, fakeCtx('cfo'));
    const data = result.data as { executed: boolean; bytes: number | null; sha256: string | null; error?: string };
    assert.equal(data.error, 'incomplete_upload');
    assert.equal(data.executed, false, 'a short write must never be reported as executed:true');
    assert.equal(data.bytes, truncatedSize, 'the actual (short) byte count Graph reported is surfaced');
    assert.equal(data.sha256, sha256Hex(content), 'the hash of what was actually sent is still returned so the caller can tell what was lost');
  });
});

test('ACCEPTANCE: Graph confirming MORE bytes than were sent is also refused as incomplete_upload (mismatch either direction)', async () => {
  const content = Buffer.from('y'.repeat(1000), 'utf8');
  await withStubbedFetch(stubGraph({ reportedSize: content.length + 5 }), async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'padded.txt', text: content.toString('utf8') }, fakeCtx('cfo'));
    const data = result.data as { executed: boolean; error?: string };
    assert.equal(data.error, 'incomplete_upload');
    assert.equal(data.executed, false);
  });
});

test('a Graph response that OMITS the size field entirely is refused as incomplete_upload, never defaulted to a false match', async () => {
  const content = Buffer.from('z'.repeat(2000), 'utf8');
  await withStubbedFetch(stubGraph({ reportedSize: 'omit' }), async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'no-size.txt', text: content.toString('utf8') }, fakeCtx('cfo'));
    const data = result.data as { executed: boolean; bytes: number | null; error?: string };
    assert.equal(data.error, 'incomplete_upload', 'an unconfirmed size must never be silently treated as a match');
    assert.equal(data.executed, false);
    assert.equal(data.bytes, null);
  });
});

// --- fail-closed overwrite (regression) -----------------------------------------------------------

test('regression: an existing file without overwrite=true is still refused, and still carries a sha256 of the attempted content', async () => {
  const content = Buffer.from('hello', 'utf8');
  await withStubbedFetch(stubGraph({ existsFirst: true }), async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'exists.txt', text: content.toString('utf8') }, fakeCtx('cfo'));
    const data = result.data as { executed: boolean; error?: string; sha256: string | null };
    assert.equal(data.error, 'exists_no_overwrite');
    assert.equal(data.executed, false);
    assert.equal(data.sha256, sha256Hex(content));
  });
});

// --- dry run --------------------------------------------------------------------------------------

test('dry_run previews the sha256 of what WOULD be written without ever calling the upload PUT', async () => {
  const content = Buffer.from('preview me', 'utf8');
  let putCalled = false;
  const stub: typeof fetch = (async (url: string | URL) => {
    const u = String(url);
    if (isLoginMicrosoftHost(u)) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (u.includes('/content')) {
      putCalled = true;
      return new Response(JSON.stringify({ id: 'x', size: content.length }), { status: 200 });
    }
    if (u.includes('%24select=id') || u.includes('$select=id')) return new Response('not found', { status: 404 });
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;

  await withStubbedFetch(stub, async () => {
    const result = await handleGraphDriveUpload({ folder: 'CFO Incoming', filename: 'preview.txt', text: content.toString('utf8') }, fakeCtx('cfo', true));
    const data = result.data as { executed: boolean; dry_run: boolean; sha256: string | null };
    assert.equal(data.executed, false);
    assert.equal(data.dry_run, true);
    assert.equal(data.sha256, sha256Hex(content));
  });
  assert.equal(putCalled, false, 'dry_run must never actually call the upload PUT');
});
