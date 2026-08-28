import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The legal store with BLOB_BACKEND=s3 and the Azure KEY genuinely absent (2026-08-18).
 *
 * Its own process on purpose. loadEnv() caches on first read, so deleting AZURE_LEGAL_STORAGE_KEY
 * after the module has been imported proves nothing at all -- isConfigured() would keep reading the
 * cached value and the test would pass under the OLD behaviour too. Only a process that never had
 * the key can demonstrate this.
 *
 * WHAT IT PINS: isConfigured() gates EVERY legal blob tool (blob-get, blob-list, blob-put,
 * blob-copy, blob-move, blob-delete) before any backend routing runs. It used to ask "is the Azure
 * SharedKey present", which was already wrong for the reads -- readCreds() was added so S3 reads
 * would not need the key, but this gate was never brought along -- and would have made the write
 * routing unreachable in precisely the situation it exists for: Azure gone, key deleted.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT = 'otchealthlegalstore';
delete process.env.AZURE_LEGAL_STORAGE_KEY; // the whole point: the dead Azure secret is GONE
process.env.BLOB_BACKEND = 's3';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const { isConfigured, putBlob } = await import('./blob-store.js');

test('with the Azure key deleted, the S3-backed legal store still reports CONFIGURED', () => {
  assert.equal(process.env.AZURE_LEGAL_STORAGE_KEY, undefined, 'this test is only meaningful with the key absent');
  assert.equal(
    isConfigured(),
    true,
    'a false here silently disables every legal blob tool, reads included, the moment the dead key is removed',
  );
});

test('a company write still completes with no Azure key present', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response('', { status: 200, headers: { etag: '"e"' } });
  }) as unknown as typeof fetch;
  try {
    const res = await putBlob('company', 'filing.pdf', { text: 'x', contentType: 'application/pdf' }, true);
    assert.equal(res.bytes, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(urls[0].includes('otchealth-finance-legal-dr-55c84f6b.s3.'), urls[0]);
});

test('a PERSONAL write with no Azure key now completes via S3 (2026-08-28 ring decision)', async () => {
  // INVERTED 2026-08-28: personal joined S3_WRITABLE_CONTAINERS (blob-store.ts) once the personal
  // DR bucket's IAM grant was widened to include PutObject/DeleteObject (infra/aws/iam.tf's
  // PersonalLegalRingReadWrite statement). This is a storage-routing change only -- the RING that
  // decides whether a caller may reach `personal` at all is untouched (ring.test.ts pins that). A
  // write with no Azure key at all must now SUCCEED against the personal DR bucket, the exact
  // opposite of this test's pre-2026-08-28 assertion (preserved in git history), because falling
  // through to a permanently-dead Azure is no longer the correct failure mode for this container.
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response('', { status: 200, headers: { etag: '"e"' } });
  }) as unknown as typeof fetch;
  try {
    const res = await putBlob('personal', 'divorce/exhibit.pdf', { text: 'x', contentType: 'application/pdf' }, true);
    assert.equal(res.bytes, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(urls.length === 1 && urls[0].includes('otchealth-legal-personal-dr-55c84f6b.s3.'), urls[0]);
});
