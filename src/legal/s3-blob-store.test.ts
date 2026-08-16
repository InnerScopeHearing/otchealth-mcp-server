import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own file/process -- loadEnv() caches on first read.
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

const { s3LocationFor, fetchBlobFromS3, s3BlobBackendActive, PERSONAL_LEGAL_BUCKET } = await import('./s3-blob-store.js');

async function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ─────────────────────────── RING SAFETY ───────────────────────────
// These are the tests that matter. A mapping bug here re-creates the 2026-08-14 contamination,
// where a privileged export landed in the shared bucket.

test('RING: attorney-privileged personal legal resolves ONLY to its own bucket', () => {
  const loc = s3LocationFor('otchealthlegalstore', 'personal');
  assert.equal(loc?.bucket, PERSONAL_LEGAL_BUCKET);
  assert.equal(loc?.keyPrefix, 'otchealthlegalstore/personal/');
});

test('RING: NOTHING except personal legal may resolve to the privileged bucket', () => {
  // The inverse of the test above, and the one that actually catches a bad row being added later.
  for (const [account, container] of [
    ['otchealthlegalstore', 'company'],
    ['otchealthlegalstore', 'exec'],
    ['otchealthcfodata', 'cfo-source-docs'],
    ['otchealthcfodata', 'cro-from-the-chair'],
    ['otchealthcfodata', 'innd-stock'],
  ] as const) {
    const loc = s3LocationFor(account, container);
    assert.ok(loc, `${account}/${container} should be mapped`);
    assert.notEqual(
      loc?.bucket,
      PERSONAL_LEGAL_BUCKET,
      `${account}/${container} must NEVER resolve to the privileged personal-legal bucket`,
    );
  }
});

test('RING: an unknown pair FAILS CLOSED rather than defaulting to a bucket', () => {
  // A default here would serve some other ring's documents. Null is the only safe answer.
  assert.equal(s3LocationFor('otchealthlegalstore', 'personal-archive'), null);
  assert.equal(s3LocationFor('someoneelsestore', 'personal'), null);
  assert.equal(s3LocationFor('', ''), null);
  assert.equal(s3LocationFor('otchealthcfodata', 'medreview-phi'), null, 'PHI must never map anywhere');
});

test('RING: a refused mapping THROWS, it does not quietly return not-found', async () => {
  // found:false would read as "the document does not exist", hiding a misconfiguration behind a
  // plausible answer. The caller must see a real error.
  await assert.rejects(
    () => fetchBlobFromS3('unknown-account', 'unknown-container', 'x.pdf'),
    /no S3 mirror mapping/,
  );
});

test('RING: personal-legal cannot be reached by passing the company container name', async () => {
  // Defence against a caller (or a future bug) trying to cross rings via the path rather than the
  // container: the bucket is chosen by the mapping, and the prefix is forced.
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response('x', { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthlegalstore', 'company', '../personal/secret.pdf'),
  );
  assert.ok(seenUrl.includes('otchealth-finance-legal-dr'), 'stays in the shared bucket');
  assert.equal(seenUrl.includes(PERSONAL_LEGAL_BUCKET), false, 'never reaches the privileged bucket');
  // The traversal segments are percent-encoded rather than resolved, so they cannot climb out of
  // the forced prefix.
  assert.ok(seenUrl.includes('otchealthlegalstore/company/'), 'the forced prefix survives');
});

// ─────────────────────────── FETCH BEHAVIOUR ───────────────────────────

test('the object key is <account>/<container>/<path>, matching the real mirror layout', async () => {
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response('data', { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthcfodata', 'cfo-source-docs', 'INND/Banking/statement.pdf'),
  );
  assert.match(seenUrl, /otchealth-finance-legal-dr-55c84f6b\.s3\.us-east-1\.amazonaws\.com/);
  assert.match(seenUrl, /otchealthcfodata\/cfo-source-docs\/INND\/Banking\/statement\.pdf/);
});

test("path separators stay separators; they are NOT encoded away", async () => {
  // Encoding '/' as %2F would look for a single key literally containing %2F and find nothing --
  // a 404 on every nested document, which is most of them.
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response('d', { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthlegalstore', 'company', 'a/b/c.txt'),
  );
  assert.equal(seenUrl.includes('%2F'), false);
  assert.match(seenUrl, /\/a\/b\/c\.txt$/);
});

test('a space in a filename is encoded, not sent raw', async () => {
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response('d', { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthlegalstore', 'company', 'my filing.pdf'),
  );
  assert.match(seenUrl, /my%20filing\.pdf/);
});

test('404 AND 403 both mean not-found, so an absent document is not an exception', async () => {
  // S3 answers 403 instead of 404 for a missing key when the caller lacks ListBucket. Treating that
  // as a hard error would turn "this document is not in the mirror" into a thrown failure.
  for (const status of [404, 403]) {
    const res = await withStubbedFetch(
      (async () => new Response('', { status })) as unknown as typeof fetch,
      () => fetchBlobFromS3('otchealthlegalstore', 'company', 'missing.pdf'),
    );
    assert.equal(res.found, false, `HTTP ${status} should read as not-found`);
    assert.equal(res.buf, null);
  }
});

test('a real failure still throws, so a broken mirror is loud', async () => {
  await assert.rejects(
    () =>
      withStubbedFetch(
        (async () => new Response('internal error', { status: 500 })) as unknown as typeof fetch,
        () => fetchBlobFromS3('otchealthlegalstore', 'company', 'x.pdf'),
      ),
    /s3 blob get 500/,
  );
});

test('a found object returns its bytes and content type', async () => {
  const res = await withStubbedFetch(
    (async () =>
      new Response('%PDF-1.7 body', { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthcfodata', 'cfo-source-docs', 'a.pdf'),
  );
  assert.equal(res.found, true);
  assert.equal(res.contentType, 'application/pdf');
  assert.equal(res.buf?.toString('utf8'), '%PDF-1.7 body');
});

test('the S3 backend is active in this scenario', () => {
  assert.equal(s3BlobBackendActive(), true);
});

test('S3 requires x-amz-content-sha256, and it must be SIGNED', async () => {
  // Without it S3 answers 400 InvalidRequest. It is in extraHeaders precisely so it lands in the
  // signed set rather than being bolted on after signing.
  let seenHeaders: Record<string, string> = {};
  await withStubbedFetch(
    (async (_u: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response('d', { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthlegalstore', 'company', 'x.txt'),
  );
  const lower = Object.fromEntries(Object.entries(seenHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  assert.ok(lower['x-amz-content-sha256'], 'header present');
  assert.match(String(lower['authorization']), /SignedHeaders=[^,]*x-amz-content-sha256/, 'and signed');
});
