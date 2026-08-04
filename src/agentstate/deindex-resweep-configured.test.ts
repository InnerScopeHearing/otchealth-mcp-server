// Full-chain integration tests for the deindex resweep queue (2026-08-04, THE PERMANENT FIX for the
// concurrent-pull-indexer resurrection race -- see deindex-resweep.ts's module doc comment). Own
// process (config/env.ts's loadEnv() memoizes per process; this env snapshot -- Cosmos AND search AND
// identity all configured -- must not collide with a file that leaves any of those unset), mirroring
// blob-deindex-configured.test.ts's pattern for exactly the same reason.
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

const { enqueueDeindexResweep, runDeindexResweepOnce, DEINDEX_RESWEEP_BOARD, DEINDEX_RESWEEP_MAX_ATTEMPTS } = await import('./deindex-resweep.js');

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
const isAdminKeyCall = (u: string) => u.includes('listAdminKeys');
const isSearchDocsCall = (u: string) => u.includes('/docs/search');
const isIndexDocsCall = (u: string) => u.includes('/docs/index');

const FAKE_TOKEN = 'fake.managed.identity.access.token.abc123';
const FAKE_ADMIN_KEY = 'fake-admin-key-0123456789';

/** An in-memory Cosmos double: enough of the REST surface (query/upsert/delete on the 'tasks'
 *  container) for the queue's own CRUD to round-trip correctly, keyed like the real service by
 *  (container, id) -- board is the partition key but this fake does not need per-partition
 *  isolation since every test uses the one dedicated resweep board. */
function makeCosmosDouble() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    handle(url: string, init: RequestInit | undefined): Response {
      const isQuery = (init?.headers as Record<string, string> | undefined)?.['x-ms-documentdb-isquery'] === 'true';
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
      if (method === 'POST') {
        // upsertDoc always sends x-ms-documentdb-is-upsert: true in this codebase's cosmos.ts.
        const doc = JSON.parse(String(init?.body)) as Record<string, unknown>;
        docs.set(String(doc.id), doc);
        return new Response(JSON.stringify(doc), { status: 200 });
      }
      if (method === 'DELETE') {
        const id = url.split('/docs/')[1];
        const existed = docs.delete(id);
        return new Response(null, { status: existed ? 204 : 404 });
      }
      throw new Error(`unhandled cosmos call: ${method} ${url}`);
    },
  };
}

function fullStub(cosmos: ReturnType<typeof makeCosmosDouble>, onSearch: (u: string, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (isCosmosCall(u)) return cosmos.handle(u, init);
    if (isIdentityCall(u)) return new Response(JSON.stringify({ access_token: FAKE_TOKEN, expires_on: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
    if (isAdminKeyCall(u)) return new Response(JSON.stringify({ primaryKey: FAKE_ADMIN_KEY }), { status: 200 });
    if (isIndexDocsCall(u)) {
      const body = JSON.parse(String(init?.body)) as { value: Array<{ chunk_id: string }> };
      return new Response(JSON.stringify({ value: body.value.map((v) => ({ key: v.chunk_id, status: true, statusCode: 200 })) }), { status: 200 });
    }
    if (isSearchDocsCall(u)) return onSearch(u, init);
    throw new Error(`unexpected call: ${u}`);
  }) as typeof fetch;
}

test('enqueueDeindexResweep writes a correctly-shaped, correctly-partitioned entry due safely past the 6h indexer cadence', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), () =>
    enqueueDeindexResweep('legal-personal', 'filings/moved.pdf'),
  );
  assert.equal(cosmos.docs.size, 1);
  const entry = [...cosmos.docs.values()][0];
  assert.equal(entry.board, DEINDEX_RESWEEP_BOARD);
  assert.equal(entry.type, 'deindex_resweep');
  assert.equal(entry.index, 'legal-personal');
  assert.equal(entry.path, 'filings/moved.pdf');
  assert.equal(entry.status, 'pending');
  assert.equal(entry.attempts, 0);
  const dueInMs = new Date(entry.due_at as string).getTime() - Date.now();
  assert.ok(dueInMs > 6 * 60 * 60 * 1000, 'must be due well past the 6h cadence');
});

test('enqueueDeindexResweep is idempotent per (index, path): a second enqueue of the same path upserts the SAME entry, not a duplicate', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), async () => {
    await enqueueDeindexResweep('legal-company', 'x.pdf');
    await enqueueDeindexResweep('legal-company', 'x.pdf');
  });
  assert.equal(cosmos.docs.size, 1, 'the same (index, path) must map to the same queue entry');
});

test('runDeindexResweepOnce: an entry that is NOT YET due (enqueued moments ago) is not processed', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, () => { throw new Error('must never reach search for a not-yet-due entry'); }), async () => {
    await enqueueDeindexResweep('legal-personal', 'future.pdf');
    const result = await runDeindexResweepOnce();
    assert.deepEqual(result, { processed: 0, cleaned: 0, requeued: 0, failed: 0 });
  });
  assert.equal(cosmos.docs.size, 1, 'the entry must remain queued, untouched');
});

test('runDeindexResweepOnce: a due entry that resolves clean (nothing left in the index) is confirmed and removed from the queue', async () => {
  const cosmos = makeCosmosDouble();
  // Enqueue, then hand-backdate due_at into the past so this tick treats it as due -- simulates
  // time having passed without a real 7h sleep in the test.
  await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), () =>
    enqueueDeindexResweep('legal-personal', 'clean.pdf'),
  );
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();

  const result = await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), () => runDeindexResweepOnce());
  assert.equal(result.processed, 1);
  assert.equal(result.cleaned, 1);
  assert.equal(result.requeued, 0);
  assert.equal(cosmos.docs.size, 0, 'a confirmed-clean entry must be removed from the queue, not left pending');
});

test('runDeindexResweepOnce: a due entry that finds and deletes a RESURRECTED stale chunk is confirmed and removed -- proves the sweep does real cleanup, not just bookkeeping', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), () =>
    enqueueDeindexResweep('legal-personal', 'resurrected.pdf'),
  );
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();

  const result = await withStubbedFetch(
    fullStub(cosmos, () => new Response(JSON.stringify({ value: [{ chunk_id: 'c1', path: 'resurrected.pdf' }] }), { status: 200 })),
    () => runDeindexResweepOnce(),
  );
  assert.equal(result.cleaned, 1, 'the resurrected chunk found by the delayed sweep must be confirmed cleaned');
  assert.equal(cosmos.docs.size, 0);
});

test('runDeindexResweepOnce: a due entry that cannot be confirmed clean (search failing) is requeued with incremented attempts and a later due_at, not dropped', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), () =>
    enqueueDeindexResweep('legal-personal', 'flaky.pdf'),
  );
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();
  const originalDueAt = entry.due_at;

  const result = await withStubbedFetch(fullStub(cosmos, () => new Response('search unavailable', { status: 503 })), () => runDeindexResweepOnce());
  assert.equal(result.requeued, 1);
  assert.equal(result.cleaned, 0);
  assert.equal(cosmos.docs.size, 1, 'a not-yet-confirmed entry must stay in the queue for a later retry');
  const updated = [...cosmos.docs.values()][0];
  assert.equal(updated.attempts, 1);
  assert.equal(updated.status, 'pending');
  assert.ok((updated.due_at as string) > originalDueAt, 'due_at must be pushed forward for the retry');
});

test('runDeindexResweepOnce: after DEINDEX_RESWEEP_MAX_ATTEMPTS failures the entry is marked failed and stops retrying, instead of retrying forever', async () => {
  const cosmos = makeCosmosDouble();
  await withStubbedFetch(fullStub(cosmos, () => new Response(JSON.stringify({ value: [] }), { status: 200 })), () =>
    enqueueDeindexResweep('legal-personal', 'permanently-broken.pdf'),
  );

  for (let i = 0; i < DEINDEX_RESWEEP_MAX_ATTEMPTS; i++) {
    const entry = [...cosmos.docs.values()][0];
    entry.due_at = new Date(Date.now() - 1000).toISOString();
    await withStubbedFetch(fullStub(cosmos, () => new Response('search unavailable', { status: 503 })), () => runDeindexResweepOnce());
  }

  const finalEntry = [...cosmos.docs.values()][0];
  assert.equal(finalEntry.status, 'failed', `must stop retrying after ${DEINDEX_RESWEEP_MAX_ATTEMPTS} attempts`);
  assert.equal(finalEntry.attempts, DEINDEX_RESWEEP_MAX_ATTEMPTS);

  // A subsequent tick must NOT pick up a 'failed' entry even if its due_at is in the past --
  // the query filters on status='pending', so a failed entry is inert, not silently retried forever.
  const entry = [...cosmos.docs.values()][0];
  entry.due_at = new Date(Date.now() - 1000).toISOString();
  const result = await withStubbedFetch(fullStub(cosmos, () => { throw new Error('must never reach search for a failed entry'); }), () => runDeindexResweepOnce());
  assert.equal(result.processed, 0);
});

test('runDeindexResweepOnce: a Cosmos query failure fails open (zero-progress result, never throws)', async () => {
  const result = await withStubbedFetch(
    (async () => { throw new Error('simulated Cosmos outage'); }) as typeof fetch,
    () => runDeindexResweepOnce(),
  );
  assert.equal(result.processed, 0);
  assert.match(result.reason ?? '', /Cosmos query failed/);
});
