import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * The S3 WRITE path (2026-08-18).
 *
 * Its own file, not an addition to s3-blob-store.test.ts, because loadEnv() caches on first read and
 * node --test gives each file its own process -- which is the only way to exercise BLOB_BACKEND=s3
 * here and BLOB_BACKEND unset in the Azure-path tests.
 *
 * What these pin, in order of how much they would cost to get wrong:
 *   1. the key is encoded EXACTLY ONCE (a double-encoded key 403s and reads as a permissions bug);
 *   2. the payload hash is the hash of the ACTUAL bytes, and is signed;
 *   3. an error THROWS -- a write that did not happen must never resolve;
 *   4. the ring mapping is the same fail-closed allow-list the reads use.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.BLOB_BACKEND = 's3';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const {
  putObjectToS3,
  copyObjectInS3,
  deleteObjectFromS3,
  getTextFromS3,
  s3LocationFor,
  PERSONAL_LEGAL_BUCKET,
} = await import('./s3-blob-store.js');

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stub fetch, capturing every request, replying with a caller-supplied sequence of responses. */
async function capture<T>(
  responses: Array<() => Response>,
  run: () => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; calls: Seen[] }> {
  const calls: Seen[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(u),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init?.body,
    });
    const make = responses[Math.min(i, responses.length - 1)];
    i++;
    return make();
  }) as unknown as typeof fetch;
  try {
    return { result: await run(), error: undefined, calls };
  } catch (error) {
    return { result: undefined, error, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const ok = () => new Response('', { status: 200, headers: { etag: '"abc123"' } });
const copyOk = () =>
  new Response('<CopyObjectResult><ETag>&quot;abc123&quot;</ETag></CopyObjectResult>', { status: 200 });

// ─────────────────────────── RING SAFETY, WRITE SIDE ───────────────────────────

test('RING: the commons feed maps to the shared bucket, NEVER the privileged personal-legal one', () => {
  const loc = s3LocationFor('otchealthcommons', 'company-journal');
  assert.ok(loc, 'the commons row must exist -- its absence WAS the outage');
  assert.equal(loc!.bucket, 'otchealth-finance-legal-dr-55c84f6b');
  assert.equal(loc!.keyPrefix, 'otchealthcommons/company-journal/');
  assert.notEqual(loc!.bucket, PERSONAL_LEGAL_BUCKET);
});

test('RING: every write verb FAILS CLOSED on an unmapped (account, container) pair', async () => {
  // A write that guessed a bucket would put data in the wrong ring -- strictly worse than a read
  // doing the same, because it persists. All three must refuse, not default.
  await assert.rejects(
    () => putObjectToS3('nope', 'nope', 'x.txt', Buffer.from('x'), 'text/plain'),
    /no S3 mirror mapping/,
  );
  await assert.rejects(() => copyObjectInS3('nope', 'nope', 'a', 'b'), /no S3 mirror mapping/);
  await assert.rejects(() => deleteObjectFromS3('nope', 'nope', 'x.txt'), /no S3 mirror mapping/);
  await assert.rejects(() => getTextFromS3('nope', 'nope', 'x.txt'), /no S3 mirror mapping/);
});

// ── SINGLE-ENCODING: the bug this file exists to keep from coming back a second time ─────────────
// S3 encodes each path segment ONCE. Every other AWS service encodes TWICE. A double-encoded key
// produces a signature mismatch that S3 answers with 403 -- which reads exactly like a permissions
// error. That is how the read-side instance of this bug (fixed 2026-08-17) survived long enough for
// ~11 present finance documents to be written up as a "data coverage gap".

async function putUrlFor(path: string): Promise<string> {
  const { calls } = await capture([ok], () =>
    putObjectToS3('otchealthcommons', 'company-journal', path, Buffer.from('body'), 'text/plain'),
  );
  return calls[0].url;
}

test('ENCODING: a written key with spaces, parentheses and a dollar sign is encoded EXACTLY once', async () => {
  const url = await putUrlFor('_MEMORY/_exec/odd keys/Report (002) $final.jsonl');

  // The single-encoding proof: the escape character itself must never be re-escaped.
  assert.equal(url.includes('%25'), false, 'a %25 anywhere means something was encoded twice');
  assert.ok(url.includes('odd%20keys'), 'space -> %20, once');
  assert.ok(url.includes('Report%20%28002%29'), "parentheses must be encoded -- encodeURIComponent alone leaves them raw");
  assert.ok(url.includes('%24final'), 'a dollar sign must be percent-encoded for the canonical form');
  // Separators stay separators, or S3 looks for one key literally containing '%2F'.
  assert.equal(url.includes('%2F'), false);
  assert.ok(url.includes('/otchealthcommons/company-journal/_MEMORY/_exec/'), 'the forced prefix survives');
});

test('ENCODING: a key needing no encoding is left completely alone', async () => {
  const url = await putUrlFor('_MEMORY/_exec/cto.jsonl');
  assert.ok(url.endsWith('/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl'));
  assert.equal(url.includes('%'), false);
});

test('ENCODING: the copy-source header uses the same single encoder as the request line', async () => {
  // x-amz-copy-source is a second place a key becomes a percent-encoded string. If it drifted from
  // the request-line encoder, copies of exactly the awkward filenames this store is full of would
  // fail -- and a copy-then-delete caller acts on that result.
  const { calls } = await capture([copyOk, ok], () =>
    copyObjectInS3('otchealthlegalstore', 'company', 'Motion (002).pdf', '_TRASH/Motion (002).pdf'),
  );
  const src = calls[0].headers['x-amz-copy-source'];
  assert.ok(src.includes('%28002%29'), 'copy source encodes parentheses');
  assert.ok(src.includes('Motion%20%28002%29.pdf'));
  assert.equal(src.includes('%25'), false, 'copy source is encoded once, not twice');
  assert.ok(src.startsWith('/otchealth-finance-legal-dr-55c84f6b/otchealthlegalstore/company/'));
});

// ─────────────────────────── PAYLOAD HASH + SIGNING ───────────────────────────

test('the signed payload hash is the hash of the ACTUAL bytes, not of an empty body', async () => {
  // The canonical request's last line must equal x-amz-content-sha256, and both must describe the
  // bytes really sent. Hashing '' while sending a body is a 403 SignatureDoesNotMatch on every write.
  const payload = Buffer.from('{"id":"20260818-001"}\n', 'utf8');
  const { calls } = await capture([ok], () =>
    putObjectToS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/cto.jsonl', payload, 'application/x-ndjson'),
  );
  const expected = createHash('sha256').update(payload).digest('hex');
  assert.equal(calls[0].headers['x-amz-content-sha256'], expected);
  assert.match(calls[0].headers['authorization'], /SignedHeaders=[^,]*x-amz-content-sha256/, 'and it is SIGNED');
  assert.equal(calls[0].method, 'PUT');
});

test('binary bytes survive: the hash is computed over the buffer, not a UTF-8 round trip', async () => {
  // 0x80-0xFF is not valid UTF-8. Hashing such a body through a JS string silently changes it, so
  // this is the case that proves the Buffer path is real rather than incidentally passing.
  const payload = Buffer.from([0x00, 0x80, 0xff, 0xfe, 0x41]);
  const { calls } = await capture([ok], () =>
    putObjectToS3('otchealthlegalstore', 'company', 'binary.bin', payload, 'application/octet-stream'),
  );
  assert.equal(calls[0].headers['x-amz-content-sha256'], createHash('sha256').update(payload).digest('hex'));
  assert.notEqual(
    calls[0].headers['x-amz-content-sha256'],
    createHash('sha256').update(payload.toString('utf8')).digest('hex'),
    'a UTF-8 round trip would corrupt these bytes; the two hashes must differ',
  );
});

test('overwrite=false sends a SIGNED If-None-Match: * so a concurrent create is refused server-side', async () => {
  const { calls } = await capture([ok], () =>
    putObjectToS3('otchealthlegalstore', 'company', 'filing.pdf', Buffer.from('x'), 'application/pdf', false),
  );
  assert.equal(calls[0].headers['if-none-match'], '*');
  assert.match(calls[0].headers['authorization'], /SignedHeaders=[^,]*if-none-match/);
});

test('overwrite=true sends no If-None-Match (the commons feed is an append-by-rewrite file)', async () => {
  const { calls } = await capture([ok], () =>
    putObjectToS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/cto.jsonl', Buffer.from('x'), 'application/x-ndjson', true),
  );
  assert.equal(calls[0].headers['if-none-match'], undefined);
});

// ─────────────────────────── FAILURES ARE LOUD ───────────────────────────

test('a 403 on a WRITE throws -- it is never folded into a plausible success', async () => {
  // The reads deliberately fold 403 into found:false (S3 answers 403 for a missing key without
  // ListBucket). On a write that reasoning does not apply: 403 means the write did not happen.
  const { error } = await capture([() => new Response('AccessDenied', { status: 403 })], () =>
    putObjectToS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/cto.jsonl', Buffer.from('x'), 'application/x-ndjson'),
  );
  assert.match(String(error), /s3 blob put 403/);
});

test('an existing object with overwrite=false throws a message naming the fix', async () => {
  const { error } = await capture([() => new Response('PreconditionFailed', { status: 412 })], () =>
    putObjectToS3('otchealthlegalstore', 'company', 'filing.pdf', Buffer.from('x'), 'application/pdf', false),
  );
  assert.match(String(error), /already exists.*overwrite=true/s);
});

test('CopyObject returning HTTP 200 with an <Error> body is treated as a FAILURE', async () => {
  // S3's documented trap: a copy that fails midway answers 200 and reports it in the payload.
  // Trusting the status code would tell a copy-then-delete caller to delete the original.
  const { error } = await capture(
    [() => new Response('<Error><Code>InternalError</Code></Error>', { status: 200 })],
    () => copyObjectInS3('otchealthlegalstore', 'company', 'a.pdf', 'b.pdf'),
  );
  assert.match(String(error), /HTTP 200 with a failed CopyObjectResult/);
});

test('CopyObject returning HTTP 200 with no ETag at all is also a failure, not a silent success', async () => {
  const { error } = await capture([() => new Response('<CopyObjectResult></CopyObjectResult>', { status: 200 })], () =>
    copyObjectInS3('otchealthlegalstore', 'company', 'a.pdf', 'b.pdf'),
  );
  assert.match(String(error), /HTTP 200 with a failed CopyObjectResult/);
});

test('a source ETag is sent as x-amz-copy-source-if-match, pinning the copy to that version', async () => {
  const { calls } = await capture([copyOk, ok], () =>
    copyObjectInS3('otchealthlegalstore', 'company', 'a.pdf', 'b.pdf', { sourceEtag: '"v1"' }),
  );
  assert.equal(calls[0].headers['x-amz-copy-source-if-match'], '"v1"');
});

test('delete with an ifMatch REFUSES when the live ETag differs, and deletes nothing', async () => {
  // REWRITTEN 2026-08-18. This test previously pinned a HEAD-then-delete check, on the false premise
  // that "S3 has no If-Match precondition on DeleteObject". It does -- the AWS S3 API reference for
  // DeleteObject states "The If-Match header is supported for both general purpose and directory
  // buckets" (only IfMatchLastModifiedTime/IfMatchSize are directory-bucket-only). The intent below
  // is UNCHANGED and the guarantee is STRICTLY STRONGER: "deletes nothing" is now enforced by S3
  // itself, so there is no window between checking and acting, and no HEAD whose 403 could be
  // misread as "already gone" and report a delete that never happened.
  const { error, calls } = await capture(
    [() => new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 })],
    () => deleteObjectFromS3('otchealthlegalstore', 'company', 'a.pdf', '"v1"'),
  );
  assert.match(String(error), /changed since it was copied/);
  assert.equal((error as Error).name, 'BlobPreconditionFailedError', 'a refusal is its own typed outcome');
  assert.equal(calls.length, 1, 'exactly one request: the conditional DELETE itself, no HEAD pre-check');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].headers['if-match'], '"v1"', 'the precondition must travel WITH the delete');
  // S3 rejected it, so the object is untouched -- guaranteed by the 412, not by a client-side guess.
});

test('delete with a MATCHING ifMatch proceeds to the DELETE', async () => {
  const { error, calls } = await capture(
    [
      // 204 is what S3 really answers to DeleteObject, and the Response constructor requires a null
      // body for it -- passing '' throws before the assertion ever runs.
      () => new Response(null, { status: 204 }),
    ],
    () => deleteObjectFromS3('otchealthlegalstore', 'company', 'a.pdf', '"v1"'),
  );
  assert.equal(error, undefined);
  assert.equal(calls.length, 1, 'one conditional DELETE, no HEAD round trip');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].headers['if-match'], '"v1"');
});

test('a failing delete throws rather than reporting an untouched object as removed', async () => {
  const { error } = await capture([() => new Response('AccessDenied', { status: 403 })], () =>
    deleteObjectFromS3('otchealthlegalstore', 'company', 'a.pdf'),
  );
  assert.match(String(error), /s3 blob delete 403/);
});

// ─────────────────────────── getTextFromS3: 404 is empty, 403 is NOT ───────────────────────────

test('getTextFromS3 returns null on 404 (a lane that has never written yet)', async () => {
  const { result } = await capture([() => new Response('NoSuchKey', { status: 404 })], () =>
    getTextFromS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/newlane.jsonl'),
  );
  assert.equal(result, null);
});

test('getTextFromS3 THROWS on 403 rather than reporting an empty feed', async () => {
  // This is the whole reason it is not a wrapper over fetchBlobFromS3, which folds 403 into
  // found:false. An empty feed reads as "nobody recorded anything" and empties the retraction set,
  // so retracted beliefs resurface through brain_search as current truth.
  const { error } = await capture([() => new Response('AccessDenied', { status: 403 })], () =>
    getTextFromS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/cto.jsonl'),
  );
  assert.match(String(error), /s3 commons get 403.*refusing to report a missing feed as empty/s);
});

test('getTextFromS3 returns the body on 200', async () => {
  const { result } = await capture([() => new Response('{"id":"20260818-001"}\n', { status: 200 })], () =>
    getTextFromS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/cto.jsonl'),
  );
  assert.equal(result, '{"id":"20260818-001"}\n');
});
