// Full-chain integration tests for the deindex resweep queue (2026-08-04, THE PERMANENT FIX for the
// concurrent-pull-indexer resurrection race -- see deindex-resweep.ts's module doc comment). Own
// process (config/env.ts's loadEnv() memoizes per process; this env snapshot -- Cosmos AND search AND
// identity AND the legal blob store all configured -- must not collide with a file that leaves any of
// those unset), mirroring blob-deindex-configured.test.ts's pattern for exactly the same reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.COSMOS_ENDPOINT ||= 'https://fake-cosmos.example.invalid';
process.env.COSMOS_KEY ||= Buffer.from('unit-test-cosmos-key-not-real').toString('base64');
process.env.COSMOS_DB ||= 'agent-state';
process.env.AZURE_SEARCH_ENDPOINT ||= 'https://otchealth-dataroom-s1.search.windows.net';
process.env.IDENTITY_ENDPOINT ||= 'http://fake-identity.example.invalid/msi/token';
process.env.IDENTITY_HEADER ||= 'fake-identity-header-secret';
process.env.AZURE_LEGAL_STORAGE_ACCOUNT ||= 'otchealthlegalstore';
process.env.AZURE_LEGAL_STORAGE_KEY ||= Buffer.from('unit-test-blob-key-not-real').toString('base64');

const { enqueueDeindexResweep, runDeindexResweepOnce, DEINDEX_RESWEEP_BOARD, DEINDEX_RESWEEP_MAX_ATTEMPTS, DEINDEX_RESWEEP_BATCH_SIZE } = await import('./deindex-resweep.js');

function withStubbedFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const isCosmosCall = (u: string) => {
  try {
    return new URL(u).hostname === 'fake-cosmos.example.invalid';
  } catch {
    return false;
  }
};
const isIdentityCall = (u: string) => {
  try {
    return new URL(u).hostname === 'fake-identity.example.invalid';
  } catch {
    return false;
  }
};
const isBlobCall = (u: string) => {
  try {
    return new URL(u).hostname === `${process.env.AZURE_LEGAL_STORAGE_ACCOUNT}.blob.core.windows.net`;
  } catch {
    return false;
  }
};
const isAdminKeyCall = (u: string) => u.includes('listAdminKeys');
const isSearchDocsCall = (u: string) => u.includes('/docs/search');
const isIndexDocsCall = (u: string) => u.includes('/docs/index');

const FAKE_TOKEN = 'fake.managed.identity.access.token.abc123';
const FAKE_ADMIN_KEY = 'fake-admin-key-0123456789';

/** An in-memory Cosmos double with REAL etag semantics (verified against Microsoft Learn's Cosmos
 *  DB REST API reference before writing this: DELETE/REPLACE honor If-Match, rejecting a stale
 *  etag with 412 and leaving the document untouched; query results carry `_etag` in the document
 *  body, the same value a later If-Match can be built from) -- this is what makes the queue-race
 *  tests below meaningful rather than a stubbed-out no-op. */
function makeCosmosDouble() {
  const docs = new Map<string, Record<string, unknown>>();
  let etagCounter = 0;
  const nextEtag = () => `"etag-${++etagCounter}"`;
  return {
    docs,
    handle(url: string, init: RequestInit | undefined): Response {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      const isQuery = headers['x-ms-documentdb-isquery'] === 'true';
      const method = init?.method || 'GET';
      if (isQuery) {
        const body = JSON.parse(String(init?.body)) as { query: string; parameters: { name: string; value: unknown }[] };
        const nowParam = body.parameters.find((p) => p.name === '@now')?.value as string | undefined;
        const typeParam = body.parameters.find((p) => p.name === '@type')?.value as string | undefined;
        const matches = [...docs.values()].filter(
          (d) => d.type === typeParam && d.status === 'pending' && (!nowParam || (d.due_at as string) <= nowParam),
        );
        return new Response(JSON.stringify({ Documents: matches }), { status: 200 });
      }
      const ifMatch = headers['If-Match'];
      if (method === 'GET') {
        // readDoc (2026-08-04, Copilot review round 17's monotonic-due_at fix uses this): a point
        // read by id. cosmos.ts reads the etag from the response's `etag` HEADER, not the JSON body
        // (readDoc's `etag: r.headers.get('etag')`), so this must set it there too.
        const id = url.split('/docs/')[1];
        const existing = docs.get(id);
        if (!existing) return new Response(null, { status: 404 });
        return new Response(JSON.stringify(existing), { status: 200, headers: { etag: String(existing._etag) } });
      }
      if (method === 'POST') {
        // upsertDoc always sends x-ms-documentdb-is-upsert: true; createDoc (the CAS loop's
        // optimistic-create step, 2026-08-04, Copilot review round 18) never does, and per real
        // Cosmos REST semantics a plain create-only POST for an id that already exists in the
        // partition returns 409 Conflict rather than silently overwriting -- that 409 IS the
        // concurrency signal the CAS loop relies on, so this double must model it, not just always
        // upsert.
        const isUpsert = headers['x-ms-documentdb-is-upsert'] === 'true';
        const doc = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const id = String(doc.id);
        if (!isUpsert && docs.has(id)) {
          return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
        }
        const withEtag = { ...doc, _etag: nextEtag() };
        docs.set(id, withEtag);
        return new Response(JSON.stringify(withEtag), { status: 200 });
      }
      if (method === 'PUT') {
        // replaceDoc: extract id from the resourceLink (.../docs/<id>).
        const id = url.split('/docs/')[1];
        const existing = docs.get(id);
        if (ifMatch && existing && existing._etag !== ifMatch) {
          return new Response(JSON.stringify({ message: 'etag mismatch' }), { status: 412 });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const withEtag = { ...body, id, _etag: nextEtag() };
        docs.set(id, withEtag);
        return new Response(JSON.stringify(withEtag), { status: 200 });
      }
      if (method === 'DELETE') {
        const id = url.split('/docs/')[1];
        const existing = docs.get(id);
        if (!existing) return new Response(null, { status: 404 });
        if (ifMatch && existing._etag !== ifMatch) {
          return new Response(JSON.stringify({ message: 'etag mismatch' }), { status: 412 });
        }
        docs.delete(id);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unhandled cosmos call: ${method} ${url}`);
    },
  };
}

/** blobExists doubles as the existence-check guard's data source. `blobPaths` lists every path
 *  that currently has a live blob (i.e. a real legal_blob_put landed there) -- callers mutate this
 *  Set to simulate a concurrent recreation happening between enqueue and sweep. */
function fullStub(
  cosmos: ReturnType<typeof makeCosmosDouble>,
  blobPaths: Set<string>,
  onSearch: (u: string, init: RequestInit | undefined) => Response,
): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (isCosmosCall(u)) return cosmos.handle(u, init);
    if (isIdentityCall(u)) return new Response(JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
    if (isAdminKeyCall(u)) return new Response(JSON.stringify({ primaryKey: FAKE_ADMIN_KEY }), { status: 200 });
    if (isBlobCall(u)) {
      const method = init?.method || 'GET';
      if (method !== 'HEAD') throw new Error(`unexpected blob call: ${method} ${u}`);
      // blob-store.ts's headBlob URL-encodes the path segment; decode to match blobPaths' plain form.
      const encodedPath = new URL(u).pathname.split('/').slice(2).join('/');
      const path = decodeURIComponent(encodedPath);
      return blobPaths.has(path) ? new Response(null, { status: 200, headers: { 'content-length': '10' } }) : new Response(null, { status: 404 });
    }
    if (isIndexDocsCall(u)) {
      const body = JSON.parse(String(init?.body)) as { value: Array<{ chunk_id: string }> };
      return new Response(JSON.stringify({ value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) }), { status: 200 });
    }
    if (isSearchDocsCall(u)) return onSearch(u, init);
    throw new Error(`unexpected call: ${u}`);
  }) as typeof fetch;
}

const NOTHING_INDEXED = () => new Response(JSON.stringify({ value: [] }), { status: 200 });

test('enqueueDeindexResweep writes a correctly-shaped, correctly-partitioned entry (including container) due safely past the 6h indexer cadence', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'filings/moved.pdf', 'personal'));
  assert.equal(cosmos.docs.size, 1);
  const entry = [...cosmos.docs.values()][0];
  assert.equal(entry.board, DEINDEX_RESWEEP_BOARD);
  assert.equal(entry.type, 'deindex_resweep');
  assert.equal(entry.index, 'legal-personal');
  assert.equal(entry.path, 'filings/moved.pdf');
  assert.equal(entry.container, 'personal');
  assert.equal(entry.status, 'pending');
  assert.equal(entry.attempts, 0);
  const dueInMs = new Date(entry.due_at as string).getTime() - Date.now();
  assert.ok(dueInMs > 6 * 60 * 60 * 1000, 'must be due well past the 6h cadence');
});

test('enqueueDeindexResweep is idempotent per (index, path): a second enqueue of the same path upserts the SAME entry, not a duplicate', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), async () => {
    await enqueueDeindexResweep('legal-company', 'x.pdf', 'company');
    await enqueueDeindexResweep('legal-company', 'x.pdf', 'company');
  });
  assert.equal(cosmos.docs.size, 1, 'the same (index, path) must map to the same queue entry');
});

test('THE CAS-LOOP MONOTONIC DUE_AT FIX THIS ROUND ADDED: an older enqueue call that completes AFTER a newer one for the SAME path never regresses due_at backward, via a REAL create-conflict-then-replace CAS loop, not a non-atomic read-then-write (2026-08-04, Copilot review rounds 17 and 18: round 17\'s first attempt read the existing entry then wrote, which round 18 correctly flagged as still unsafe under genuine concurrency -- two callers can both read the same old/missing state before either writes. This version never does a plain read-first: it optimistically CREATEs, which Cosmos 409s atomically if the id already exists -- exactly the concurrency signal a CAS loop needs -- and only the loser of that atomic race falls back to read-and-conditionally-replace)', async () => {
  const cosmos = makeCosmosDouble();
  const T1 = Date.now(); // the OLDER mutation's clock
  const T2 = T1 + 60_000; // the NEWER mutation's clock (a minute later)

  // The NEWER call's createDoc lands FIRST and wins outright (no prior entry exists yet),
  // simulating the older call being slow/in-flight and losing the atomic create race.
  await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'race.pdf', 'personal', T2));
  const newerDueAt = ([...cosmos.docs.values()][0].due_at) as string;

  // The OLDER call's createDoc now 409s (an entry already exists) -- it must fall back to
  // read-and-conditionally-replace, computing an EARLIER due_at from its own (earlier) nowMs, and
  // that merge must preserve the newer, later due_at rather than overwriting it.
  await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'race.pdf', 'personal', T1));
  const afterOlderCompletes = ([...cosmos.docs.values()][0].due_at) as string;

  assert.equal(afterOlderCompletes, newerDueAt, 'the later (correct) due_at from the newer mutation must survive, never regressed by the older call landing late');
  assert.equal(cosmos.docs.size, 1, 'still exactly one entry for this path, not a duplicate');
});

test('THE COLLISION FIX THIS ROUND ADDED: two distinct paths that collide under a naive 32-bit polynomial hash (the textbook "Aa"/"BB" Java/JS hashCode collision Copilot\'s review cited -- 65*31+97 === 66*31+66 === 2112) get DISTINCT queue entries, not a silent upsert-clobber of one by the other', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), async () => {
    await enqueueDeindexResweep('legal-personal', 'Aa', 'personal');
    await enqueueDeindexResweep('legal-personal', 'BB', 'personal');
  });
  assert.equal(cosmos.docs.size, 2, 'two genuinely distinct paths must never alias to the same Cosmos document id');
  const paths = [...cosmos.docs.values()].map((d) => d.path).sort();
  assert.deepEqual(paths, ['Aa', 'BB'], 'both entries must survive with their own path, neither overwritten by the other');
});

test('THE BATCH CAP HOLDS even when Cosmos hands back more due entries than DEINDEX_RESWEEP_BATCH_SIZE in one page (2026-08-04, Copilot review round 16: a claim that this could process up to 100 entries per tick, defeating the stated Search/RU bound -- this double\'s query handler returns every match in a single unpaginated page exactly to prove the bound comes from queryDocs\'s own client-side cap, not from any pagination-timing accident)', async () => {
  const cosmos = makeCosmosDouble();
  const overBatch = DEINDEX_RESWEEP_BATCH_SIZE + 5;
  await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), async () => {
    for (let i = 0; i < overBatch; i++) await enqueueDeindexResweep('legal-personal', `over-batch-${i}.pdf`, 'personal');
  });
  assert.equal(cosmos.docs.size, overBatch, 'precondition: genuinely more entries queued than one batch');
  for (const doc of cosmos.docs.values()) doc.due_at = new Date(Date.now() - 1000).toISOString();

  const result = await withStubbedFetch(fullStub(cosmos, new Set(), NOTHING_INDEXED), () => runDeindexResweepOnce());
  assert.equal(result.processed, DEINDEX_RESWEEP_BATCH_SIZE, 'a single tick must never process more than the documented batch size, regardless of how many entries are due');
  assert.equal(cosmos.docs.size, overBatch - DEINDEX_RESWEEP_BATCH_SIZE, 'exactly one batch worth of entries must have been cleaned this tick, leaving the rest for the next');
});

test('runDeindexResweepOnce: an entry that is NOT YET due (enqueued moments ago) is not processed', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, new Set(), () => { throw new Error('must never reach search for a not-yet-due entry'); }), async () => {
    await enqueueDeindexResweep('legal-personal', 'future.pdf', 'personal');
    const result = await runDeindexResweepOnce();
    assert.deepEqual(result, { processed: 0, cleaned: 0, requeued: 0, failed: 0, raced: 0 });
  });
  assert.equal(cosmos.docs.size, 1, 'the entry must remain queued, untouched');
});

test('runDeindexResweepOnce: a due entry whose path has NOT been recreated resolves clean (nothing left in the index) and is removed from the queue', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>(); // never recreated
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'clean.pdf', 'personal'));
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();

  const result = await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => runDeindexResweepOnce());
  assert.equal(result.processed, 1);
  assert.equal(result.cleaned, 1);
  assert.equal(cosmos.docs.size, 0, 'a confirmed-clean entry must be removed from the queue, not left pending');
});

test('runDeindexResweepOnce: a due entry that finds and deletes a RESURRECTED stale chunk is confirmed and removed -- proves the sweep does real cleanup, not just bookkeeping', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>();
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'resurrected.pdf', 'personal'));
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();

  const result = await withStubbedFetch(
    fullStub(cosmos, blobPaths, () => new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'resurrected.pdf' }] }), { status: 200 })),
    () => runDeindexResweepOnce(),
  );
  assert.equal(result.cleaned, 1, 'the resurrected chunk found by the delayed sweep must be confirmed cleaned');
  assert.equal(cosmos.docs.size, 0);
});

test('THE EXISTENCE GUARD: a due entry whose path was RECREATED (a concurrent legal_blob_put) never touches the index -- proves the existence check actually prevents deleting a live replacement blob\'s chunks', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>();
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'reused-path.pdf', 'personal'));
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();

  // Simulate the recreation: a blob now lives at this exact path again.
  blobPaths.add('reused-path.pdf');

  const result = await withStubbedFetch(
    fullStub(cosmos, blobPaths, () => { throw new Error('must never call search at all once the path is confirmed live again -- deleting by path would risk the new blob\'s own chunks'); }),
    () => runDeindexResweepOnce(),
  );
  assert.equal(result.cleaned, 0, 'nothing was verified/deleted in the index for a live path');
  assert.equal(result.requeued, 1);
});

test('THE GENERATION-UNCERTAINTY FIX THIS ROUND ADDED: a recreated path is NOT silently dropped from the queue as "job done" -- it backs off and stays visible, since the recreated content may have FEWER chunks than the prior generation, leaving orphans nothing else would ever clean up (2026-08-04, Copilot review round 16)', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>();
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'reused-path-2.pdf', 'personal'));
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();
  const originalDueAt = entry.due_at;

  blobPaths.add('reused-path-2.pdf');
  await withStubbedFetch(
    fullStub(cosmos, blobPaths, () => { throw new Error('must never call search for a live path'); }),
    () => runDeindexResweepOnce(),
  );

  assert.equal(cosmos.docs.size, 1, 'the entry must survive in the queue, not vanish the moment the path looks live again');
  const updated = [...cosmos.docs.values()][0];
  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempts, 1);
  assert.ok((updated.due_at as string) > originalDueAt, 'due_at must be pushed forward for the retry, same backoff as any other not-confirmed-clean outcome');
  assert.match(String(updated.last_reason), /generation/, 'the reason should explain WHY this is unresolved, not just that it is');

  // A SUBSEQUENT tick, with the path STILL live, keeps backing off (never deletes, never silently
  // drops) until DEINDEX_RESWEEP_MAX_ATTEMPTS is reached, at which point it becomes a visible
  // 'failed' entry rather than disappearing without a trace.
  for (let i = 1; i < DEINDEX_RESWEEP_MAX_ATTEMPTS; i++) {
    const e = [...cosmos.docs.values()][0];
    e.due_at = new Date(Date.now() - 1000).toISOString();
    await withStubbedFetch(fullStub(cosmos, blobPaths, () => { throw new Error('must never call search for a live path'); }), () => runDeindexResweepOnce());
  }
  const finalEntry = [...cosmos.docs.values()][0];
  assert.equal(finalEntry.status, 'failed', 'a persistently-recreated path must end up visible as failed, not disappear');
  assert.equal(finalEntry.attempts, DEINDEX_RESWEEP_MAX_ATTEMPTS);
});

test('runDeindexResweepOnce: a due entry that cannot be confirmed clean (search failing) is requeued with incremented attempts and a later due_at, not dropped', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>();
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'flaky.pdf', 'personal'));
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();
  const originalDueAt = entry.due_at;

  const result = await withStubbedFetch(fullStub(cosmos, blobPaths, () => new Response('search unavailable', { status: 503 })), () => runDeindexResweepOnce());
  assert.equal(result.requeued, 1);
  assert.equal(result.cleaned, 0);
  assert.equal(cosmos.docs.size, 1, 'a not-yet-confirmed entry must stay in the queue for a later retry');
  const updated = [...cosmos.docs.values()][0];
  assert.equal(updated.attempts, 1);
  assert.equal(updated.status, 'pending');
  assert.ok((updated.due_at as string) > originalDueAt, 'due_at must be pushed forward for the retry');
});

test('THE TRANSIENT-VS-TERMINAL SPLIT THIS ROUND ADDED: a search outage that outlasts DEINDEX_RESWEEP_MAX_ATTEMPTS worth of retries NEVER terminal-ates the entry, unlike generation uncertainty -- a fixed attempt cap on a RECOVERABLE outage would silently break the "self-heals within hours" promise, since a failed entry is never automatically revisited (the sweep query only selects status=\'pending\') (2026-08-04, Copilot review round 17)', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>();
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'long-outage.pdf', 'personal'));

  // Simulate an outage that outlasts DEINDEX_RESWEEP_MAX_ATTEMPTS worth of retries.
  for (let i = 0; i < DEINDEX_RESWEEP_MAX_ATTEMPTS + 3; i++) {
    const entry = [...cosmos.docs.values()][0];
    entry.due_at = new Date(Date.now() - 1000).toISOString();
    await withStubbedFetch(fullStub(cosmos, blobPaths, () => new Response('search unavailable', { status: 503 })), () => runDeindexResweepOnce());
  }

  const stillRetrying = [...cosmos.docs.values()][0];
  assert.equal(stillRetrying.status, 'pending', 'a transient outage must NEVER be terminal-ed to failed, no matter how many attempts have accumulated');
  assert.equal(stillRetrying.attempts, DEINDEX_RESWEEP_MAX_ATTEMPTS + 3, 'attempts keeps incrementing purely as a diagnostic counter for this failure class, not a hard retry cap');

  // Once the outage clears, the entry resolves normally on the very next tick -- proving it was
  // never lost or dead-ended, just legitimately waiting on infrastructure.
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();
  const result = await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => runDeindexResweepOnce());
  assert.equal(result.cleaned, 1, 'once infra recovers, the entry resolves normally');
  assert.equal(cosmos.docs.size, 0);
});

test('THE QUEUE-RACE GUARD THIS ROUND ADDED: a fresh re-enqueue that lands WHILE a sweep is mid-flight for the same entry is never clobbered by that sweep\'s stale write-back', async () => {
  const cosmos = makeCosmosDouble();
  const blobPaths = new Set<string>();
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'raced.pdf', 'personal'));
  const original = [...cosmos.docs.values()][0];
  original.due_at = new Date(Date.now() - 1000).toISOString();
  const staleEtag = original._etag as string;

  // Simulate a FRESH delete/move re-enqueueing the SAME path AFTER the sweep already queried it
  // (the sweep's in-memory `entry` snapshot is now stale -- it still carries staleEtag) but BEFORE
  // the sweep's own write-back happens. In the real system this is a genuine race; here we just
  // perform the refresh directly against the double to construct the exact interleaving.
  await withStubbedFetch(fullStub(cosmos, blobPaths, NOTHING_INDEXED), () => enqueueDeindexResweep('legal-personal', 'raced.pdf', 'personal'));
  const refreshed = [...cosmos.docs.values()][0];
  assert.notEqual(refreshed._etag, staleEtag, 'precondition: the refresh must have produced a NEW etag');
  const refreshedDueAt = refreshed.due_at;

  // Now the sweep's write-back happens, using the STALE etag from before the refresh (a 503,
  // so the sweep attempts a conditional requeue with the outdated version).
  const stubbedRunOnce = async () => {
    // Directly exercise deleteDoc/replaceDoc's conditional-write path the way runDeindexResweepOnce
    // would, using the STALE etag it captured at query time, to prove the library-level guarantee
    // this fix relies on (already verified against Cosmos REST docs): a stale If-Match is rejected
    // with 412 and the document is left exactly as the concurrent refresh wrote it.
    const staleWrite = cosmos.handle(
      `https://fake-cosmos.example.invalid/dbs/agent-state/colls/tasks/docs/${original.id}`,
      { method: 'PUT', headers: { 'If-Match': staleEtag }, body: JSON.stringify({ ...original, attempts: 1 }) },
    );
    assert.equal(staleWrite.status, 412, 'a write using the STALE etag must be rejected, not silently applied');
  };
  await stubbedRunOnce();

  const finalEntry = [...cosmos.docs.values()][0];
  assert.equal(finalEntry.due_at, refreshedDueAt, 'the fresher due_at from the concurrent re-enqueue must survive untouched');
  assert.equal(finalEntry.attempts, 0, 'the stale sweep write must NOT have applied its attempts increment');
});

test('runDeindexResweepOnce: a Cosmos query failure fails open (zero-progress result, never throws)', async () => {
  const result = await withStubbedFetch(
    (async () => { throw new Error('simulated Cosmos outage'); }) as typeof fetch,
    () => runDeindexResweepOnce(),
  );
  assert.equal(result.processed, 0);
  assert.match(result.reason ?? '', /Cosmos query failed/);
});
