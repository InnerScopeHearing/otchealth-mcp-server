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
    // Added with the commons row (2026-08-18). The shared exec brain is the one WRITABLE room in
    // this table, which makes it the row where a wrong bucket would be worst: it would put every
    // agent's memory feed into the attorney-privileged ring.
    ['otchealthcommons', 'company-journal'],
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

// ── THE COMMONS BUCKET LOCK (2026-08-18) ─────────────────────────────────────────────────────────
// The shared exec brain was misrouted for real, in production. The commons row was added pointing at
// otchealth-finance-legal-dr-55c84f6b on the strength of an IAM grant, with nobody listing the actual
// objects. A read-only listing of the live estate then showed the brain has always been in
// otchealth-brain-dr-55c84f6b: 29 lane files under `otchealthcommons/company-journal/_MEMORY/_exec/`,
// all latest, zero delete markers (cto.jsonl 1,236,579 bytes, cfo.jsonl 1,956,515, clo.jsonl 932,806,
// developer.jsonl 896,103, cro.jsonl 623,446, coo.jsonl 194,935, and ~23 more). Against the wrong
// bucket the gateway 404'd, treated that as an empty feed, and wrote a fresh 725-byte single-entry
// cto.jsonl there at 02:35:34Z -- memory_team then reported shared_entry_count=1 where months of
// history belong.
//
// The IAM reasoning could never have decided this: infra/aws/iam.tf grants GetObject + PutObject +
// ListBucket over brain_dr and finance_legal_dr in the SAME statement, in both ARN shapes. A grant
// covering both buckets identically cannot discriminate between them -- it proves a write is allowed,
// never where the data is. These tests pin the observed answer instead.
//
// Both assert LITERAL bucket names rather than importing a constant from the module under test: a
// test that sources its expectation from the code it is checking agrees with that code by
// construction, including when the code is wrong. That is exactly how the original row shipped green.

test('LOCK: commons resolves to the brain-dr bucket, and to NO other bucket', () => {
  const loc = s3LocationFor('otchealthcommons', 'company-journal');
  assert.ok(loc, 'the commons row must exist -- its absence was the original memory_remember outage');
  assert.equal(
    loc?.bucket,
    'otchealth-brain-dr-55c84f6b',
    'the real 29-lane exec brain lives here; any other bucket 404s and silently reads as an empty feed',
  );
  assert.equal(
    loc?.keyPrefix,
    'otchealthcommons/company-journal/',
    'the prefix was already correct against the live listing -- only the bucket was ever wrong',
  );
});

test('LOCK: commons NEVER resolves to EITHER legal bucket, because commons is not a privileged ring', () => {
  // Commons is the shared, non-privileged, every-agent feed. Both legal buckets are ring-gated: the
  // personal one is attorney-privileged (clo-personal + exec), the finance-legal one carries company
  // legal, CFO finance and MNPI. Routing the shared brain into either puts every agent's memory writes
  // inside a privileged-ring bucket. Naming both explicitly keeps the finance-legal case a NAMED
  // regression vector rather than something this suite happens to miss.
  const loc = s3LocationFor('otchealthcommons', 'company-journal');
  assert.ok(loc, 'the commons row must exist');
  assert.notEqual(
    loc?.bucket,
    'otchealth-finance-legal-dr-55c84f6b',
    'THE ACTUAL 2026-08-18 MISROUTE: commons must not resolve to the finance/company-legal bucket',
  );
  assert.notEqual(
    loc?.bucket,
    PERSONAL_LEGAL_BUCKET,
    'commons must never resolve to the attorney-privileged personal-legal bucket',
  );
});

test('LOCK: a commons READ addresses the brain-dr host on the wire, not merely in the table', async () => {
  // The table is one thing; the request built from it is another. If s3LocationFor were right but the
  // location -> URL step regressed, the two tests above would still pass. This one would not.
  let seenUrl = '';
  await withStubbedFetch(
    (async (u: string) => {
      seenUrl = String(u);
      return new Response('{"a":1}\n', { status: 200 });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthcommons', 'company-journal', '_MEMORY/_exec/cto.jsonl'),
  );
  assert.equal(
    new URL(seenUrl).host,
    'otchealth-brain-dr-55c84f6b.s3.us-east-1.amazonaws.com',
    `commons reads must hit brain-dr, got ${seenUrl}`,
  );
  assert.ok(seenUrl.endsWith('/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl'));
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

// ── Key encoding: exactly once, and via the signer's own canonicaliser ───────────────────────────
// THE BUG THIS PINS (2026-08-17): the path was pre-encoded with encodeURIComponent and the result
// was ALSO handed to signRequest, which canonicalises internally. A space therefore travelled as
// `%20` on the wire but `%2520` inside the signed canonical request. S3 rejected the signature with
// 403, and the 403 branch reports `found:false` -- so every object key containing a space was
// silently unreadable while reporting as ABSENT. ~11 finance documents were written up as a "data
// coverage gap" on that basis; all of them existed. Keys needing no encoding were unaffected, which
// is why it survived so long.
//
// encodeURIComponent was also the wrong encoder even applied once: it leaves `!*'()` raw, while
// AWS's canonical form requires them percent-encoded, and real filenames here contain parentheses.
async function urlFor(path: string): Promise<string> {
  let seen = '';
  await withStubbedFetch(
    (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response('x', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthcfodata', 'cfo-source-docs', path),
  );
  return seen;
}

test('a key containing SPACES is encoded once (%20), never double-encoded (%2520)', async () => {
  const url = await urlFor('INND/FinanceTeam/Accounts Payable/INND/INND BANK BREAKDOWN.xlsx');
  assert.equal(url.includes('%2520'), false, 'double-encoded: the signature will not match and S3 answers 403');
  assert.ok(url.includes('Accounts%20Payable'), 'space should be a single %20');
  assert.ok(url.includes('INND%20BANK%20BREAKDOWN.xlsx'));
  // '/' stays a separator -- encoding it would look for a key with a literal %2F in its name.
  assert.ok(url.includes('/otchealthcfodata/cfo-source-docs/INND/FinanceTeam/'));
});

test('AWS-reserved characters encodeURIComponent leaves raw are encoded too', async () => {
  // Parentheses appear in real keys ("... (002) ..."), and '#' in the audit-item filenames.
  const url = await urlFor('INND/x (002) y/#5.2 HA incomplete.xlsx');
  assert.ok(url.includes('%28002%29'), 'parentheses must be percent-encoded for the canonical form');
  assert.ok(url.includes('%235.2'), "'#' must be percent-encoded or it truncates the URL as a fragment");
  assert.equal(url.includes('%2523'), false, 'still exactly once');
});

test('a key needing no encoding is unchanged (the case that always worked, kept working)', async () => {
  const url = await urlFor('INND/_KNOWLEDGE-BASE/CFO_PROJECT_MEMORY.md');
  assert.ok(url.endsWith('/otchealthcfodata/cfo-source-docs/INND/_KNOWLEDGE-BASE/CFO_PROJECT_MEMORY.md'));
  assert.equal(url.includes('%'), false);
});

// ── Legal READ path on the mirror (2026-08-17) ───────────────────────────────────────────────────
// BLOB_BACKEND=s3 was honoured in exactly ONE function, the raw byte fetch. listBlobs/getBlob/
// headBlob each hand-rolled their own Azure call and ignored the switch, so the CLO's legal document
// surface stayed pinned to Azure while the CFO's finance reads had already moved. If Azure went
// dark, legal documents stopped and finance documents kept working -- and no preflight caught it,
// because the preflight only ever exercised the finance path.
function xmlList(keys: Array<{ key: string; size: number }>, next?: string): string {
  return (
    '<ListBucketResult>' +
    keys.map((k) => `<Contents><Key>${k.key}</Key><Size>${k.size}</Size><LastModified>2026-08-17T00:00:00.000Z</LastModified><ETag>"abc"</ETag></Contents>`).join('') +
    (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') +
    '</ListBucketResult>'
  );
}

test('listBlobsFromS3 strips the mirror prefix so names match what Azure would have returned', async () => {
  const { listBlobsFromS3 } = await import('./s3-blob-store.js');
  const rows = await withStubbedFetch(
    (async () =>
      new Response(
        xmlList([
          { key: 'otchealthlegalstore/company/01-Matters/Motion &amp; Order.pdf', size: 42 },
          { key: 'otchealthlegalstore/company/notes.md', size: 7 },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch,
    () => listBlobsFromS3('otchealthlegalstore', 'company'),
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['01-Matters/Motion & Order.pdf', 'notes.md'],
    'prefix stripped and &amp; decoded -- a real legal filename contains an ampersand',
  );
  assert.equal(rows[0].size, 42);
});

test('listBlobsFromS3 THROWS on a 403 rather than reporting an empty container', async () => {
  const { listBlobsFromS3 } = await import('./s3-blob-store.js');
  await withStubbedFetch(
    (async () => new Response('AccessDenied', { status: 403 })) as unknown as typeof fetch,
    async () => {
      // The whole point: a credential/signature failure that reports as "no documents" is how a
      // false-absence conclusion gets written into a legal or finance finding.
      await assert.rejects(() => listBlobsFromS3('otchealthlegalstore', 'company'), /s3 blob list 403/);
    },
  );
});

// ── LIST 404 honesty (2026-08-18) ─────────────────────────────────────────────────────────────────
// THE INCIDENT THIS PINS: the commons container was mapped to the wrong bucket. Every one of its 23
// real sub-prefixes 404'd against that bucket, and the OLD code (`if (r.status === 404) break;`)
// turned each of those into a normal, successful, EMPTY listing -- so the shared exec ledger read
// back "1 entry" where 24 lanes of real history lived, with no error anywhere. A LIST 404 can only
// mean the BUCKET itself does not exist (ListObjectsV2 answers a missing/empty *prefix* inside a
// real bucket with 200 + an empty <ListBucketResult>, never 404) -- so it must never be read as "the
// room is empty". This is the LIST-side counterpart to the existing 403 test above, and it is
// DELIBERATELY THE OPPOSITE of how fetchBlobFromS3's GET path treats a 404 -- see the two tests below
// this one, which lock both halves down so nobody "fixes" one to match the other.

test('listBlobsFromS3 THROWS on a 404, naming the bucket, instead of returning an empty listing', async () => {
  const { listBlobsFromS3 } = await import('./s3-blob-store.js');
  await withStubbedFetch(
    (async () => new Response('NoSuchBucket', { status: 404 })) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => listBlobsFromS3('otchealthlegalstore', 'company'),
        /s3 blob list 404.*otchealth-finance-legal-dr-55c84f6b/s,
        'must throw and must name the actual bucket it tried to list, not just say "404"',
      );
    },
  );
});

test('a genuinely empty prefix inside a real bucket still returns an empty list normally (no throw)', async () => {
  // The behaviour a 404 must NEVER be confused with: S3's real "nothing here" answer is HTTP 200
  // with a <ListBucketResult> that has zero <Contents> elements, not a 404. This must keep working
  // exactly as before -- the fix only changes what happens on an actual 404.
  const { listBlobsFromS3 } = await import('./s3-blob-store.js');
  const rows = await withStubbedFetch(
    (async () => new Response(xmlList([]), { status: 200 })) as unknown as typeof fetch,
    () => listBlobsFromS3('otchealthlegalstore', 'company', 'no-such-prefix/'),
  );
  assert.deepEqual(rows, [], 'an empty prefix is a normal empty array, not an exception');
});

test('LOCK: fetchBlobFromS3 (GET) still folds a 404 into found:false -- LIST and GET must stay opposite', async () => {
  // GET and LIST disagree on what a 404 means (see the comment in s3-blob-store.ts above the LIST
  // 404 branch), so the GET path's existing found:false-on-404 behaviour must be untouched by this
  // change. This test would fail if someone "fixed" fetchBlobFromS3 to throw on 404 to match LIST.
  const res = await withStubbedFetch(
    (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    () => fetchBlobFromS3('otchealthlegalstore', 'company', 'missing.pdf'),
  );
  assert.equal(res.found, false, 'GET on a missing key must still read as not-found, never throw');
  assert.equal(res.buf, null);
});

test('listBlobsFromS3 follows the continuation token to exhaustion', async () => {
  const { listBlobsFromS3 } = await import('./s3-blob-store.js');
  let call = 0;
  const rows = await withStubbedFetch(
    (async () => {
      call += 1;
      return call === 1
        ? new Response(xmlList([{ key: 'otchealthlegalstore/company/a.md', size: 1 }], 'TOKEN2'), { status: 200 })
        : new Response(xmlList([{ key: 'otchealthlegalstore/company/b.md', size: 2 }]), { status: 200 });
    }) as unknown as typeof fetch,
    () => listBlobsFromS3('otchealthlegalstore', 'company'),
  );
  assert.deepEqual(rows.map((r) => r.name), ['a.md', 'b.md'], 'a truncated first page must not be returned as the whole set');
  assert.equal(call, 2);
});

test('RING: the new list/head verbs resolve personal to the privileged bucket, and nothing else there', async () => {
  const { listBlobsFromS3, headBlobFromS3, PERSONAL_LEGAL_BUCKET } = await import('./s3-blob-store.js');
  let host = '';
  const capture = (async (url: string | URL) => {
    host = new URL(String(url)).host;
    return new Response(xmlList([]), { status: 200 });
  }) as unknown as typeof fetch;

  await withStubbedFetch(capture, () => listBlobsFromS3('otchealthlegalstore', 'personal'));
  assert.ok(host.startsWith(PERSONAL_LEGAL_BUCKET), `personal must list from the privileged bucket, got ${host}`);

  await withStubbedFetch(capture, () => listBlobsFromS3('otchealthlegalstore', 'company'));
  assert.equal(host.startsWith(PERSONAL_LEGAL_BUCKET), false, 'company must NEVER resolve to the personal bucket');

  await withStubbedFetch(
    (async (url: string | URL) => {
      host = new URL(String(url)).host;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch,
    () => headBlobFromS3('otchealthlegalstore', 'personal', 'x.md'),
  );
  assert.ok(host.startsWith(PERSONAL_LEGAL_BUCKET), 'headBlobFromS3 must honour the same ring mapping');
});

test('the new verbs FAIL CLOSED on an unmapped container rather than guessing a bucket', async () => {
  const { listBlobsFromS3, headBlobFromS3 } = await import('./s3-blob-store.js');
  await assert.rejects(() => listBlobsFromS3('otchealthlegalstore', 'not-a-container'), /no S3 mirror mapping/);
  await assert.rejects(() => headBlobFromS3('nope', 'company', 'x'), /no S3 mirror mapping/);
});

test('headBlobFromS3 single-encodes the key (same S3 exception as the byte fetch)', async () => {
  const { headBlobFromS3 } = await import('./s3-blob-store.js');
  let url = '';
  await withStubbedFetch(
    (async (u: string | URL) => {
      url = String(u);
      return new Response('', { status: 200, headers: { 'content-length': '5', etag: '"e"' } });
    }) as unknown as typeof fetch,
    () => headBlobFromS3('otchealthlegalstore', 'company', 'a b/c (1).pdf'),
  );
  assert.ok(url.includes('a%20b'), 'space encoded once');
  assert.equal(url.includes('%2520'), false, 'never double-encoded');
  assert.ok(url.includes('%281%29'), 'parentheses encoded, as AWS canonical form requires');
});
