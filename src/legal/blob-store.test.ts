import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { azSig, listBlobs, copyBlob, deleteBlobHard } from './blob-store.js';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT ||= 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY ||= Buffer.from('unit-test-shared-key-not-a-real-secret').toString('base64');

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

// Locks the Azure Blob SharedKey signature construction to the EXACT StringToSign used by the proven
// skills/legal/legal.mjs `azSig` against this same account. If the 13-field StringToSign, the
// canonicalized-headers order, the canonicalized-resource form, or the HMAC-over-base64-decoded-key
// ever drift, this test fails — the wire signature must stay byte-identical to the working skill.

// A throwaway, syntactically-valid base64 key (NOT a real credential).
const ACCT = 'otchealthlegalstore';
const KEY = Buffer.from('unit-test-shared-key-not-a-real-secret').toString('base64');

/** Independent reference implementation of the legal.mjs azSig StringToSign, computed here from
 * first principles so the test is a genuine cross-check rather than a copy of the impl. */
function referenceSig(
  method: string,
  container: string,
  blob: string,
  xms: Record<string, string>,
  query: Record<string, string> | null,
  contentLength: string,
  contentType: string,
): string {
  const canonHeaders =
    Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join('\n') + '\n';
  let canonResource = `/${ACCT}/${container}` + (blob ? `/${blob}` : '');
  if (query) for (const k of Object.keys(query).sort()) canonResource += `\n${k.toLowerCase()}:${query[k]}`;
  const sts = [method, '', '', contentLength || '', '', contentType || '', '', '', '', '', '', '', canonHeaders + canonResource].join('\n');
  const sig = crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update(sts, 'utf8').digest('base64');
  return `SharedKey ${ACCT}:${sig}`;
}

test('GET blob signature matches the reference StringToSign', () => {
  const xms = { 'x-ms-date': 'Mon, 06 Jul 2026 00:00:00 GMT', 'x-ms-version': '2021-06-08' };
  const got = azSig(ACCT, KEY, 'GET', 'personal', 'matters/2026-divorce.json', xms, null, '', '');
  assert.equal(got, referenceSig('GET', 'personal', 'matters/2026-divorce.json', xms, null, '', ''));
});

test('PUT blob signature includes Content-Length + Content-Type in the right StringToSign fields', () => {
  const xms = { 'x-ms-blob-type': 'BlockBlob', 'x-ms-date': 'Mon, 06 Jul 2026 00:00:00 GMT', 'x-ms-version': '2021-06-08' };
  const got = azSig(ACCT, KEY, 'PUT', 'company', 'filings/petition.pdf', xms, null, '2048', 'application/pdf');
  assert.equal(got, referenceSig('PUT', 'company', 'filings/petition.pdf', xms, null, '2048', 'application/pdf'));
});

test('list (comp=list) signature folds the canonicalized query into the resource', () => {
  const xms = { 'x-ms-date': 'Mon, 06 Jul 2026 00:00:00 GMT', 'x-ms-version': '2021-06-08' };
  const query = { comp: 'list', prefix: 'matters/', restype: 'container' };
  const got = azSig(ACCT, KEY, 'GET', 'personal', '', xms, query, '', '');
  assert.equal(got, referenceSig('GET', 'personal', '', xms, query, '', ''));
});

test('signature is HMAC-SHA256 over the BASE64-DECODED key (not the raw string)', () => {
  const xms = { 'x-ms-date': 'x', 'x-ms-version': '2021-06-08' };
  const withDecoded = azSig(ACCT, KEY, 'GET', 'company', 'a.json', xms, null, '', '');
  // Recompute using the RAW (non-decoded) key — must differ, proving we base64-decode the key.
  const canonHeaders = Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join('\n') + '\n';
  const sts = ['GET', '', '', '', '', '', '', '', '', '', '', '', canonHeaders + `/${ACCT}/company/a.json`].join('\n');
  const wrong = `SharedKey ${ACCT}:${crypto.createHmac('sha256', KEY).update(sts, 'utf8').digest('base64')}`;
  assert.notEqual(withDecoded, wrong);
});

// ifMatch (2026-08-04, PR #190 review: DELETE now supports a conditional If-Match guard so a
// copy-then-delete can be pinned to the exact source version that was copied) slots into the
// STS's DEDICATED If-Match field (index 8), NOT into canonHeaders — it is a standard HTTP header,
// not an x-ms-* header, so mixing it up would sign the wrong string entirely.
test('ifMatch is placed in the STS If-Match slot, distinct from ifNoneMatch, and changes the signature', () => {
  const xms = { 'x-ms-date': 'x', 'x-ms-version': '2021-06-08' };
  const withIfMatch = azSig(ACCT, KEY, 'DELETE', 'personal', 'a.pdf', xms, null, '', '', '', '"etag-1"');
  const canonHeaders = Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join('\n') + '\n';
  const sts = ['DELETE', '', '', '', '', '', '', '', '"etag-1"', '', '', '', canonHeaders + `/${ACCT}/personal/a.pdf`].join('\n');
  const expected = `SharedKey ${ACCT}:${crypto.createHmac('sha256', Buffer.from(KEY, 'base64')).update(sts, 'utf8').digest('base64')}`;
  assert.equal(withIfMatch, expected);
  // Must differ from the no-ifMatch signature (proves the parameter actually participates).
  const withoutIfMatch = azSig(ACCT, KEY, 'DELETE', 'personal', 'a.pdf', xms, null, '', '');
  assert.notEqual(withIfMatch, withoutIfMatch);
  // Must differ from putting the SAME value in ifNoneMatch instead -- If-Match and If-None-Match are
  // different STS slots, so swapping them must produce a different signature, not an accidental match.
  const asIfNoneMatch = azSig(ACCT, KEY, 'DELETE', 'personal', 'a.pdf', xms, null, '', '', '"etag-1"');
  assert.notEqual(withIfMatch, asIfNoneMatch);
});

// --- listBlobs: XML entity decoding + full pagination (2026-08-04, PR #190 review) ---

test('listBlobs: decodes XML entities in blob names (a real "&" survives a list-then-mutate round trip)', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>dupes/a&amp;b.pdf</Name><Content-Length>10</Content-Length><Etag>"e1"</Etag></Blob></Blobs></EnumerationResults>`;
  const items = await withStubbedFetch((async () => new Response(xml, { status: 200 })) as typeof fetch, () => listBlobs('personal', 'dupes/'));
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'dupes/a&b.pdf', 'the decoded name must match the REAL blob name, not the XML-escaped form');
  assert.equal(items[0].etag, '"e1"');
});

test('listBlobs: paginates to exhaustion via NextMarker rather than trusting a single page', async () => {
  const page1 = `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>1</Content-Length></Blob></Blobs><NextMarker>marker-1</NextMarker></EnumerationResults>`;
  const page2 = `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>dupes/b.pdf</Name><Content-Length>1</Content-Length></Blob></Blobs><NextMarker></NextMarker></EnumerationResults>`;
  const seenMarkers: string[] = [];
  const stub: typeof fetch = (async (url: string | URL) => {
    const u = String(url);
    const m = /marker=([^&]*)/.exec(u);
    seenMarkers.push(m ? decodeURIComponent(m[1]) : '');
    return new Response(seenMarkers.length === 1 ? page1 : page2, { status: 200 });
  }) as typeof fetch;
  const items = await withStubbedFetch(stub, () => listBlobs('personal', 'dupes/'));
  assert.deepEqual(items.map((i) => i.name), ['dupes/a.pdf', 'dupes/b.pdf'], 'both pages must be collected, not just the first');
  assert.deepEqual(seenMarkers, ['', 'marker-1'], 'the second request must carry the marker from the first page NextMarker');
});

test('listBlobs: a single page with no NextMarker (or an empty one) stops after one request (existing single-page fixtures stay byte-identical)', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults><Blobs><Blob><Name>a.pdf</Name></Blob></Blobs></EnumerationResults>`;
  let calls = 0;
  const items = await withStubbedFetch((async () => { calls += 1; return new Response(xml, { status: 200 }); }) as typeof fetch, () => listBlobs('personal'));
  assert.equal(calls, 1);
  assert.equal(items.length, 1);
});

// --- copyBlob: the async (pending -> success / pending -> timeout / failed) branches (PR #190 review: none of these had test coverage) ---

test('copyBlob: an async copy that goes pending -> success polls via HEAD and completes normally', async () => {
  let headCalls = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'pending' } });
    if (method === 'HEAD') {
      headCalls += 1;
      // First poll still pending, second poll succeeded; then the final byte-count HEAD.
      if (headCalls === 1) return new Response(null, { status: 200, headers: { 'x-ms-copy-status': 'pending' } });
      if (headCalls === 2) return new Response(null, { status: 200, headers: { 'x-ms-copy-status': 'success' } });
      return new Response(null, { status: 200, headers: { 'content-length': '55' } });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const result = await withStubbedFetch(stub, () => copyBlob('personal', 'a.pdf', 'b.pdf', false));
  assert.equal(result.copyStatus, 'success');
  assert.equal(result.bytes, 55);
  assert.ok(headCalls >= 3, 'must have polled at least twice plus the final byte-count HEAD');
});

test('copyBlob: an async copy that never leaves pending within the poll window throws a distinct timeout error', async () => {
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'pending' } });
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'x-ms-copy-status': 'pending' } });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  await assert.rejects(
    () => withStubbedFetch(stub, () => copyBlob('personal', 'a.pdf', 'b.pdf', false)),
    /did not complete \(status=pending\)/,
  );
});

test('copyBlob: an aborted/failed async copy status throws a distinct (non-timeout) error', async () => {
  let headCalls = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'pending' } });
    if (method === 'HEAD') {
      headCalls += 1;
      return new Response(null, { status: 200, headers: { 'x-ms-copy-status': 'failed' } });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  await assert.rejects(
    () => withStubbedFetch(stub, () => copyBlob('personal', 'a.pdf', 'b.pdf', false)),
    /failed to complete \(status=failed\)/,
  );
  assert.equal(headCalls, 1, 'must stop polling immediately on a terminal non-success status, not keep polling until the 20s deadline');
});

// --- deleteBlobHard: the If-Match / 412 guard (PR #190 review) ---

test('deleteBlobHard: sends If-Match when given, and throws a distinct error on a 412 (source changed since it was copied)', async () => {
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)['If-Match'], '"v1"');
    return new Response(null, { status: 412 });
  }) as typeof fetch;
  await assert.rejects(() => withStubbedFetch(stub, () => deleteBlobHard('personal', 'a.pdf', '"v1"')), /changed since it was copied/);
});

test('deleteBlobHard: no ifMatch given sends no If-Match header (unpinned delete, backward compatible)', async () => {
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)['If-Match'], undefined);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  await withStubbedFetch(stub, () => deleteBlobHard('personal', 'a.pdf'));
});
