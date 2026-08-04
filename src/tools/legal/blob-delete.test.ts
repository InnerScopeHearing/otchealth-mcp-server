import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.AZURE_LEGAL_STORAGE_ACCOUNT ||= 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY ||= Buffer.from('unit-test-key-not-real').toString('base64');

const { handleLegalBlobDelete, trashPathFor, DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS } = await import('./blob-delete.js');

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const NETWORK_FORBIDDEN: typeof fetch = (async (url: string | URL) => {
  throw new Error(`UNEXPECTED network call to ${String(url)} -- should have refused before Azure was reached`);
}) as typeof fetch;

function fakeCtx(callerAgent: string, dryRun = false) {
  return { correlationId: 'test-corr', callerHash: 'test-hash', dryRun, acknowledgeWarning: false, callerAgent };
}

test('trashPathFor: prefixes with _TRASH/', () => {
  assert.equal(trashPathFor('filings/2026/petition.pdf'), '_TRASH/filings/2026/petition.pdf');
});

test('forbidden_ring: refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'a.pdf', confirm: 'a.pdf' }, fakeCtx('cfo')),
  );
  assert.equal((res.data as any).error, 'forbidden_ring');
});

test('invalid_input: both path and prefix given is refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'a.pdf', prefix: 'x/', confirm: 'a.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'invalid_input');
});

test('invalid_input: neither path nor prefix given is refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', confirm: 'anything' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'invalid_input');
});

test('confirm_mismatch: a confirm that does not exactly echo path is refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'a.pdf', confirm: 'a.pdf ' /* trailing space */ }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'confirm_mismatch');
});

test('protected_prefix (single mode): refused before any network call, even with a correct confirm', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'filings/2026/petition.pdf', confirm: 'filings/2026/petition.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'protected_prefix');
});

test('protected_prefix (prefix/bulk mode): refused before any network call', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'filings/', confirm: 'filings/' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'protected_prefix');
});

test('single mode not_found: refuses when the blob does not exist', async () => {
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 404 });
    throw new Error('must not go further');
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'ghost.pdf', confirm: 'ghost.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'not_found');
});

test('single mode dry_run: reports the plan (moved: [{from,to}]) without any PUT/DELETE', async () => {
  const calls: string[] = [];
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push(method);
    if (method === 'HEAD') return new Response(null, { status: 200 }); // src exists
    throw new Error(`unexpected ${method} in dry_run`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'dupe.pdf', confirm: 'dupe.pdf' }, fakeCtx('clo-personal', true)),
  );
  assert.equal((res.data as any).dry_run, true);
  assert.deepEqual((res.data as any).moved, [{ from: 'dupe.pdf', to: '_TRASH/dupe.pdf' }]);
  assert.ok(!calls.includes('PUT') && !calls.includes('DELETE'));
});

test('single mode success: copies to _TRASH/<path> THEN deletes the original, in that order', async () => {
  const order: string[] = [];
  let headCount = 0;
  const stub: typeof fetch = (async (url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const u = String(url);
    if (method === 'HEAD') {
      headCount += 1;
      order.push('HEAD');
      // 1st HEAD = src exists (200), 2nd HEAD = trash-collision check for the target (404 = no collision)
      return new Response(null, { status: headCount === 1 ? 200 : 404 });
    }
    if (method === 'PUT') {
      order.push('PUT');
      assert.ok(u.includes('_TRASH'), `PUT destination must be under _TRASH/, got ${u}`);
      return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '10' } });
    }
    if (method === 'DELETE') {
      order.push('DELETE');
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'dupe.pdf', confirm: 'dupe.pdf' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).executed, true);
  assert.deepEqual((res.data as any).moved, [{ from: 'dupe.pdf', to: '_TRASH/dupe.pdf' }]);
  const putIdx = order.indexOf('PUT');
  const delIdx = order.indexOf('DELETE');
  assert.ok(putIdx >= 0 && delIdx >= 0 && putIdx < delIdx);
});

test('bulk mode too_many_matches: refuses the WHOLE batch (no PUT/DELETE at all) when matches exceed max_items', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>${Array.from({ length: 3 }, (_, i) =>
    `<Blobs><Blob><Name>dupes/${i}.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>`,
  ).join('')}</EnumerationResults>`;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') return new Response(xml, { status: 200 }); // list op
    throw new Error(`must not ${method} when over max_items`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', max_items: 2, confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).error, 'too_many_matches');
  assert.equal((res.data as any).matched, 3);
  assert.deepEqual((res.data as any).moved, []);
});

test('bulk mode: never re-trashes items already under _TRASH/ (filtered out of the candidate set)', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>_TRASH/dupes/old.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  let headCount = 0;
  const putCalls: string[] = [];
  const stub: typeof fetch = (async (url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') return new Response(xml, { status: 200 });
    if (method === 'HEAD') {
      headCount += 1;
      return new Response(null, { status: 404 }); // no trash collision
    }
    if (method === 'PUT') {
      putCalls.push(String(url));
      return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '10' } });
    }
    if (method === 'DELETE') return new Response(null, { status: 202 });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).matched, 1, 'the already-trashed item must be excluded from the candidate set');
  assert.equal(putCalls.length, 1);
  assert.ok(putCalls[0].includes('dupes/a.pdf'));
});

test('bulk mode: stops mid-batch on a trash_collision and reports exactly what moved so far', async () => {
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>dupes/a.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>dupes/b.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  let headCallsForCollision = 0;
  const stub: typeof fetch = (async (url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const u = String(url);
    if (method === 'GET') return new Response(xml, { status: 200 });
    if (method === 'HEAD') {
      headCallsForCollision += 1;
      // First item's trash-collision check: no collision (404). Second item's: COLLISION (200).
      return new Response(null, { status: headCallsForCollision === 1 ? 404 : 200 });
    }
    if (method === 'PUT') return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success', 'content-length': '10' } });
    if (method === 'DELETE') return new Response(null, { status: 202 });
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'dupes/', confirm: 'dupes/' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).error, 'trash_collision');
  assert.equal((res.data as any).moved.length, 1, 'exactly the first item should have moved before the stop');
  assert.equal((res.data as any).moved[0].from, 'dupes/a.pdf');
});

test('max_items respects the hard cap boundary (schema-level, sanity check on the exported constants)', () => {
  assert.equal(DEFAULT_MAX_ITEMS, 100);
  assert.equal(HARD_MAX_ITEMS, 500);
});
