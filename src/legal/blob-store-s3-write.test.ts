import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Legal document WRITES under BLOB_BACKEND=s3 (2026-08-18) — and the ring line that must hold.
 *
 * putBlob / copyBlob / deleteBlobHard called creds() unconditionally, so they were Azure-only no
 * matter what BLOB_BACKEND said. Shared-ring containers now write to the mirror.
 *
 * `personal` NOW DOES TOO (2026-08-28) — this repo's code and tests are built to that target state
 * ahead of an explicit owner (Matt) approval decision, not asserting that approval as already
 * granted; see blob-store.ts's S3_WRITABLE_CONTAINERS header and s3-blob-store.ts's MIRROR table
 * header for the full reasoning and the approval-gate pointer: Azure's permanent deletion turned
 * "personal writes fall through to Azure and fail loudly" from a safety rail into a permanent
 * outage of the CLO's entire personal-legal write surface. The tests that matter most in this file
 * are STILL the ring-safety ones, but the
 * invariant they prove has flipped from "personal never reaches S3" to "personal reaches its OWN
 * privileged bucket (otchealth-legal-personal-dr-55c84f6b) and never the shared one
 * (otchealth-finance-legal-dr-55c84f6b), and vice versa" — a cross-bucket mixup, not S3-vs-Azure, is
 * the actual danger once both containers are S3-writable. The RING that decides whether a caller
 * may reach `personal` at all (PERSONAL_LEGAL_RING, enforced by src/tools/legal/ring.ts before any
 * store call) is completely untouched by this file or by the 2026-08-28 change; see ring.test.ts.
 *
 * Own file: BLOB_BACKEND=s3 must be set before loadEnv() caches, and blob-store.test.ts covers the
 * Azure default.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT = 'otchealthlegalstore';
// Present ON PURPOSE: with the Azure key available, a personal write CAN still succeed on Azure.
// That makes "personal went to Azure" a real routing decision rather than an artefact of a missing
// credential, which is the only way this file actually proves the ring line.
process.env.AZURE_LEGAL_STORAGE_KEY = Buffer.from('k'.repeat(32)).toString('base64');
process.env.BLOB_BACKEND = 's3';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const { putBlob, copyBlob, deleteBlobHard } = await import('./blob-store.js');
const { PERSONAL_LEGAL_BUCKET } = await import('./s3-blob-store.js');

const SHARED_BUCKET_HOST = 'otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com';

interface Seen {
  url: string;
  method: string;
}

async function capture<T>(
  handler: (call: Seen) => Response,
  run: () => Promise<T>,
): Promise<{ error: unknown; calls: Seen[] }> {
  const calls: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const call: Seen = { url: String(u), method: init?.method ?? 'GET' };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  try {
    await run();
    return { error: undefined, calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = original;
  }
}

const alwaysOk = () => new Response('', { status: 200, headers: { etag: '"e"', 'content-length': '3' } });

// ─────────────────── company: the shared ring writes to the mirror ───────────────────

test('a company PUT goes to the shared S3 bucket', async () => {
  const { error, calls } = await capture(alwaysOk, () =>
    putBlob('company', '01-Matters/filing.pdf', { text: 'x', contentType: 'application/pdf' }, true),
  );
  assert.equal(error, undefined);
  assert.ok(calls[0].url.startsWith(`https://${SHARED_BUCKET_HOST}/`), calls[0].url);
  assert.ok(calls[0].url.endsWith('/otchealthlegalstore/company/01-Matters/filing.pdf'));
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url.includes('blob.core.windows.net'), false);
});

test('a company DELETE goes to the shared S3 bucket', async () => {
  const { error, calls } = await capture(() => new Response(null, { status: 204 }), () =>
    deleteBlobHard('company', 'old.pdf'),
  );
  assert.equal(error, undefined);
  assert.equal(calls[0].method, 'DELETE');
  assert.ok(calls[0].url.startsWith(`https://${SHARED_BUCKET_HOST}/`));
});

test('a company COPY goes to the shared S3 bucket and reports real bytes from a HEAD', async () => {
  const { error, calls } = await capture(
    (call) =>
      call.method === 'HEAD'
        ? new Response('', { status: 200, headers: { 'content-length': '4242', etag: '"e"' } })
        : new Response('<CopyObjectResult><ETag>&quot;e&quot;</ETag></CopyObjectResult>', { status: 200 }),
    () => copyBlob('company', 'a.pdf', '_TRASH/a.pdf', true),
  );
  assert.equal(error, undefined);
  assert.ok(calls.every((c) => !c.url.includes('blob.core.windows.net')), 'no Azure call');
  assert.ok(calls[0].url.startsWith(`https://${SHARED_BUCKET_HOST}/`));
});

// ─────────────────── personal: the ring line. These are the load-bearing tests. ───────────────────
// INVERTED 2026-08-28 (see file header): personal now writes to S3 too. What must hold is that it
// lands in its OWN privileged bucket, never the shared one, and the shared containers never land in
// the privileged bucket either -- a cross-bucket mixup is the actual danger now, not S3-vs-Azure.

test('RING: a personal PUT goes to the PRIVILEGED S3 bucket, never the shared one, never Azure', async () => {
  const { error, calls } = await capture(alwaysOk, () =>
    putBlob('personal', 'divorce/exhibit.pdf', { text: 'x', contentType: 'application/pdf' }, true),
  );
  assert.equal(error, undefined);
  assert.ok(calls[0].url.startsWith(`https://${PERSONAL_LEGAL_BUCKET}.s3.`), calls[0].url);
  assert.ok(calls[0].url.endsWith('/otchealthlegalstore/personal/divorce/exhibit.pdf'));
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls.some((c) => c.url.includes('blob.core.windows.net')), false, 'no Azure call');
  assert.equal(calls.some((c) => c.url.includes(SHARED_BUCKET_HOST)), false, 'must never land in the shared bucket');
});

test('RING: a personal DELETE goes to the PRIVILEGED S3 bucket', async () => {
  const { error, calls } = await capture(() => new Response(null, { status: 204 }), () =>
    deleteBlobHard('personal', 'divorce/exhibit.pdf'),
  );
  assert.equal(error, undefined);
  assert.equal(calls[0].method, 'DELETE');
  assert.ok(calls[0].url.startsWith(`https://${PERSONAL_LEGAL_BUCKET}.s3.`));
  assert.equal(calls.some((c) => c.url.includes(SHARED_BUCKET_HOST)), false);
});

test('RING: a personal COPY goes to the PRIVILEGED S3 bucket and reports real bytes from a HEAD', async () => {
  const { error, calls } = await capture(
    (call) =>
      call.method === 'HEAD'
        ? new Response('', { status: 200, headers: { 'content-length': '4242', etag: '"e"' } })
        : new Response('<CopyObjectResult><ETag>&quot;e&quot;</ETag></CopyObjectResult>', { status: 200 }),
    () => copyBlob('personal', 'a.pdf', 'b.pdf', true),
  );
  assert.equal(error, undefined);
  assert.ok(calls.length > 0);
  assert.equal(calls.some((c) => c.url.includes('blob.core.windows.net')), false, 'no Azure call');
  assert.equal(calls.some((c) => c.url.includes(SHARED_BUCKET_HOST)), false, 'privileged documents must not land in the shared bucket');
  assert.ok(calls[0].url.startsWith(`https://${PERSONAL_LEGAL_BUCKET}.s3.`));
});

test('RING: company and personal writes made in the same test run land in DIFFERENT buckets', async () => {
  // The cross-bucket-mixup regression this whole file exists to catch, made explicit: run both
  // writes back to back and assert their destination hosts differ. This is the one property a
  // shared/wrong mapping row could silently violate while every other test above still passes.
  const companyRun = await capture(alwaysOk, () => putBlob('company', 'x.pdf', { text: 'x' }, true));
  const personalRun = await capture(alwaysOk, () => putBlob('personal', 'y.pdf', { text: 'y' }, true));
  assert.equal(companyRun.error, undefined);
  assert.equal(personalRun.error, undefined);
  assert.ok(companyRun.calls[0].url.startsWith(`https://${SHARED_BUCKET_HOST}/`));
  assert.ok(personalRun.calls[0].url.startsWith(`https://${PERSONAL_LEGAL_BUCKET}.s3.`));
  assert.notEqual(new URL(companyRun.calls[0].url).host, new URL(personalRun.calls[0].url).host);
});

// ─────────────────── the no-silent-clobber default survives the backend change ───────────────────

test('overwrite=false on a company PUT is still refused server-side when the object exists', async () => {
  const { error } = await capture(() => new Response('PreconditionFailed', { status: 412 }), () =>
    putBlob('company', 'filing.pdf', { text: 'x' }, false),
  );
  assert.match(String(error), /already exists.*overwrite=true/s);
});
