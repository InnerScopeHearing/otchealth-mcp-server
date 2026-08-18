import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Legal document WRITES under BLOB_BACKEND=s3 (2026-08-18) — and the ring line that must hold.
 *
 * putBlob / copyBlob / deleteBlobHard called creds() unconditionally, so they were Azure-only no
 * matter what BLOB_BACKEND said. Shared-ring containers now write to the mirror.
 *
 * `personal` DOES NOT, and the tests that matter most in this file are the ones proving it. The
 * attorney-privileged personal-legal DR bucket is granted GetObject + ListBucket only
 * (infra/aws/iam.tf, PersonalLegalRingReadOnly). Routing personal writes there would not be a bug
 * fix, it would be a request to widen a privileged ring's IAM — a decision nobody has made. So a
 * personal write must keep going to Azure and fail LOUDLY if Azure is unavailable, never quietly
 * relocate privileged documents into a bucket picked by a code change.
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

test('RING: a personal PUT stays on Azure and never touches ANY S3 bucket', async () => {
  const { error, calls } = await capture(() => new Response('', { status: 201 }), () =>
    putBlob('personal', 'divorce/exhibit.pdf', { text: 'x' }, true),
  );
  assert.equal(error, undefined);
  assert.match(calls[0].url, /otchealthlegalstore\.blob\.core\.windows\.net\/personal\/divorce\/exhibit\.pdf/);
  assert.equal(calls.some((c) => c.url.includes('amazonaws.com')), false, 'no S3 call whatsoever');
  assert.equal(calls.some((c) => c.url.includes(PERSONAL_LEGAL_BUCKET)), false);
});

test('RING: a personal DELETE stays on Azure', async () => {
  const { calls } = await capture(() => new Response('', { status: 202 }), () =>
    deleteBlobHard('personal', 'divorce/exhibit.pdf'),
  );
  assert.match(calls[0].url, /blob\.core\.windows\.net\/personal\//);
  assert.equal(calls.some((c) => c.url.includes('amazonaws.com')), false);
});

test('RING: a personal COPY stays on Azure', async () => {
  const { calls } = await capture(
    () => new Response('', { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '9' } }),
    () => copyBlob('personal', 'a.pdf', 'b.pdf', true),
  );
  assert.ok(calls.length > 0);
  assert.equal(calls.some((c) => c.url.includes('amazonaws.com')), false, 'privileged documents must not be written to S3');
  assert.match(calls[0].url, /blob\.core\.windows\.net\/personal\//);
});

test('RING: with Azure gone, a personal write FAILS LOUDLY instead of falling back to S3', async () => {
  // The honest failure. A silent S3 fallback here would relocate attorney-privileged documents into
  // a bucket whose ring nobody signed off on -- strictly worse than an error the CLO can see.
  const { error, calls } = await capture(() => new Response('host not found', { status: 503 }), () =>
    putBlob('personal', 'divorce/exhibit.pdf', { text: 'x' }, true),
  );
  assert.match(String(error), /legal blob put 503/);
  assert.equal(calls.some((c) => c.url.includes('amazonaws.com')), false);
});

// ─────────────────── the no-silent-clobber default survives the backend change ───────────────────

test('overwrite=false on a company PUT is still refused server-side when the object exists', async () => {
  const { error } = await capture(() => new Response('PreconditionFailed', { status: 412 }), () =>
    putBlob('company', 'filing.pdf', { text: 'x' }, false),
  );
  assert.match(String(error), /already exists.*overwrite=true/s);
});
