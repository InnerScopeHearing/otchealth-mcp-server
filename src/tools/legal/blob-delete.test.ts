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
  // PR #191 review: as_of is null (not an empty string) precisely when the call refused BEFORE ever
  // observing storage -- no listing/HEAD happened here, so there is nothing to timestamp.
  assert.equal((res.data as any).as_of, null);
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
  // PR #191 review: not_found IS based on a real HEAD observation, so as_of must be a real
  // timestamp here, not the null default that only applies to pre-storage-read refusals.
  assert.ok(typeof (res.data as any).as_of === 'string' && (res.data as any).as_of.length > 0);
});

test('single mode dry_run: reports the plan (moved: [{from,to}]) without any PUT/DELETE, and preflights the trash collision', async () => {
  const calls: string[] = [];
  let headCount = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push(method);
    if (method === 'HEAD') {
      headCount += 1;
      // 1st HEAD = src exists check, 2nd HEAD = dry-run trash-collision preflight (404 = no collision).
      return new Response(null, { status: headCount === 1 ? 200 : 404 });
    }
    throw new Error(`unexpected ${method} in dry_run`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'dupe.pdf', confirm: 'dupe.pdf' }, fakeCtx('clo-personal', true)),
  );
  assert.equal((res.data as any).dry_run, true);
  assert.deepEqual((res.data as any).moved, [{ from: 'dupe.pdf', to: '_TRASH/dupe.pdf' }]);
  assert.deepEqual((res.data as any).collisions, []);
  assert.ok(!calls.includes('PUT') && !calls.includes('DELETE'));
});

test('single mode dry_run: a trash-destination collision is reported in collisions, not moved, and still issues no PUT/DELETE', async () => {
  const calls: string[] = [];
  let headCount = 0;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    calls.push(method);
    if (method === 'HEAD') {
      headCount += 1;
      // 1st HEAD = src exists, 2nd HEAD = trash preflight -- COLLIDES this time (200).
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected ${method} in dry_run`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'dupe.pdf', confirm: 'dupe.pdf' }, fakeCtx('clo-personal', true)),
  );
  assert.equal((res.data as any).dry_run, true);
  assert.deepEqual((res.data as any).moved, []);
  assert.deepEqual((res.data as any).collisions, [{ from: 'dupe.pdf', to: '_TRASH/dupe.pdf' }]);
  assert.equal(headCount, 2);
  assert.ok(!calls.includes('PUT') && !calls.includes('DELETE'));
});

test('single mode: a path already under _TRASH/ is refused (already_trashed) before any network call, even with a correct confirm', async () => {
  const res = await withStubbedFetch(NETWORK_FORBIDDEN, () =>
    handleLegalBlobDelete({ container: 'personal', path: '_TRASH/a.pdf', confirm: '_TRASH/a.pdf' }, fakeCtx('clo-personal')),
  );
  assert.equal((res.data as any).error, 'already_trashed');
});

test('single mode success: copies to _TRASH/<path> (pinned to the source ETag) THEN deletes the original, in that order', async () => {
  const order: string[] = [];
  let headCount = 0;
  const stub: typeof fetch = (async (url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    const u = String(url);
    if (method === 'HEAD') {
      headCount += 1;
      order.push('HEAD');
      // 1st HEAD = src exists (200, carrying an ETag), 2nd HEAD = live trash-collision check
      // (404 = no collision), 3rd HEAD = the post-copy byte-count HEAD on the trash destination.
      if (headCount === 1) return new Response(null, { status: 200, headers: { etag: '"v1"' } });
      if (headCount === 2) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'content-length': '10' } });
    }
    if (method === 'PUT') {
      order.push('PUT');
      const h = init?.headers as Record<string, string>;
      assert.ok(u.includes('_TRASH'), `PUT destination must be under _TRASH/, got ${u}`);
      assert.equal(h['x-ms-source-if-match'], '"v1"', 'the copy must be pinned to the source ETag observed above');
      return new Response(null, { status: 202, headers: { 'x-ms-copy-status': 'success' } });
    }
    if (method === 'DELETE') {
      order.push('DELETE');
      assert.equal((init?.headers as Record<string, string>)['If-Match'], '"v1"', 'the delete must be pinned to the same source ETag the copy used');
      return new Response(null, { status: 202 });
    }
    throw new Error(`unexpected ${method}`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', path: 'dupe.pdf', confirm: 'dupe.pdf' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).executed, true);
  assert.deepEqual((res.data as any).moved, [{ from: 'dupe.pdf', to: '_TRASH/dupe.pdf' }]);
  // deindexChunkedPath runs after each successful move but fails open here (this file's env
  // preamble sets no AZURE_SEARCH_ENDPOINT/IDENTITY_ENDPOINT, mirroring "search unconfigured" in
  // production) -- it must never throw, block the delete, or trigger any network call beyond the
  // stub above (which throws on anything unexpected, so reaching this assertion already proves it).
  assert.equal((res.data as any).deindexed, 0, 'deindex is best-effort and fails open when search is unconfigured');
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
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
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
  assert.equal((res.data as any).executed, true, 'at least one item moved before the stop, so this is a partial execution, not a no-op');
  assert.equal((res.data as any).moved.length, 1, 'exactly the first item should have moved before the stop');
  assert.equal((res.data as any).moved[0].from, 'dupes/a.pdf');
  assert.deepEqual((res.data as any).collisions, [{ from: 'dupes/b.pdf', to: '_TRASH/dupes/b.pdf' }]);
  // PR #191 review: a collision stop is the SAME "batch stopped with items unprocessed" situation
  // as a time-budget stop, just for a different reason -- status must say 'partial' (not the base
  // default 'complete') and remaining must be accurate, or a caller trusting status alone would
  // wrongly conclude the operation finished while remaining simultaneously says otherwise. The real
  // move that already happened must also be audited like any other mutation.
  assert.equal((res.data as any).status, 'partial');
  assert.equal((res.data as any).remaining, 1);
  assert.deepEqual((res as any).audit, { before: { matched: 2 }, after: { movedToTrash: 1 } });
  assert.ok(typeof (res.data as any).as_of === 'string' && (res.data as any).as_of.length > 0);
});

test('bulk mode: a prefix that is an ANCESTOR of a protected prefix refuses the whole batch (no PUT/DELETE), not just an exact protected match', async () => {
  // prefix="clo-outgoing/" is not itself in LEGAL_PROTECTED_PREFIXES, but one of its candidates
  // falls under the protected "clo-outgoing/Divorce Case Summary and ALL Filings/" subtree -- the
  // whole batch must refuse, not silently skip that one candidate (2026-08-04, PR #190 review).
  const xml = `<?xml version="1.0"?><EnumerationResults>
    <Blobs><Blob><Name>clo-outgoing/01-Divorce/note.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
    <Blobs><Blob><Name>clo-outgoing/Divorce Case Summary and ALL Filings/order.pdf</Name><Content-Length>10</Content-Length></Blob></Blobs>
  </EnumerationResults>`;
  const stub: typeof fetch = (async (_url, init?: RequestInit) => {
    const method = init?.method || 'GET';
    if (method === 'GET') return new Response(xml, { status: 200 });
    throw new Error(`must not ${method} when a candidate is protected`);
  }) as typeof fetch;
  const res = await withStubbedFetch(stub, () =>
    handleLegalBlobDelete({ container: 'personal', prefix: 'clo-outgoing/', confirm: 'clo-outgoing/' }, fakeCtx('clo-personal', false)),
  );
  assert.equal((res.data as any).error, 'protected_prefix');
  assert.equal((res.data as any).matched, 2);
  assert.deepEqual((res.data as any).moved, []);
});

test('max_items respects the hard cap boundary (schema-level, sanity check on the exported constants)', () => {
  assert.equal(DEFAULT_MAX_ITEMS, 100);
  assert.equal(HARD_MAX_ITEMS, 500);
});
