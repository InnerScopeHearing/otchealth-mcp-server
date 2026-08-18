import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The commons memory store on BLOB_BACKEND=s3 — the write path that was DOWN.
 *
 * `memory_remember` -> appendShared() -> putText() had no S3 branch at all, so once Azure
 * subscription 55c84f6b went away every write threw `commons put 403`. And it threw BEFORE
 * remember.ts reaches its OpenSearch index step, so nothing landed anywhere: those writes were lost
 * outright, not merely unindexed.
 *
 * Its own file because loadEnv() caches on first read; store.test.ts covers the Azure path with
 * BLOB_BACKEND unset, and node --test gives each file its own process.
 *
 * NOTE the deliberate omission below: AZURE_COMMONS_STORAGE_ACCOUNT and _KEY are NOT set here. That
 * is the point of the last test in this file -- the S3 path must survive the dead Azure secrets
 * finally being deleted, or removing them takes the commons feed down a second time.
 */

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
delete process.env.AZURE_COMMONS_STORAGE_ACCOUNT;
delete process.env.AZURE_COMMONS_STORAGE_KEY;
process.env.BLOB_BACKEND = 's3';
process.env.OPENSEARCH_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const { appendShared, readSharedAll, isConfigured } = await import('./store.js');

/**
 * The commons feed's real home, corrected 2026-08-18.
 *
 * This constant used to read otchealth-finance-legal-dr-55c84f6b, matching the first version of the
 * MIRROR row in src/legal/s3-blob-store.ts -- so the three assertions below agreed with the mapping
 * and proved only that the two were consistent, not that either was right. They were not: a
 * read-only listing of the live estate found the shared exec brain in otchealth-brain-dr-55c84f6b
 * (29 lane files under `otchealthcommons/company-journal/_MEMORY/_exec/`, all latest, zero delete
 * markers). Writing to the finance-legal host 404'd, read as an empty feed, and produced a fresh
 * 725-byte single-entry cto.jsonl there, after which memory_team reported shared_entry_count=1
 * against months of real history.
 *
 * Keep this host pinned to the bucket the objects are actually in. It is deliberately a literal
 * rather than an import from the mapping under test: a constant read out of the code being checked
 * agrees with that code even when the code is wrong, which is precisely how the bug shipped green.
 */
const S3_BUCKET_HOST = 'otchealth-brain-dr-55c84f6b.s3.us-east-1.amazonaws.com';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

async function capture<T>(
  handler: (call: Seen) => Response,
  run: () => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; calls: Seen[] }> {
  const calls: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const call: Seen = { url: String(u), method: init?.method ?? 'GET', body: init?.body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  try {
    return { result: await run(), error: undefined, calls };
  } catch (error) {
    return { result: undefined, error, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** appendShared does a GET (read the existing feed) then a PUT (write it back). */
function feedHandler(existing: string | null): (call: Seen) => Response {
  return (call) => {
    if (call.method === 'PUT') return new Response('', { status: 200, headers: { etag: '"e"' } });
    if (existing === null) return new Response('NoSuchKey', { status: 404 });
    return new Response(existing, { status: 200 });
  };
}

// ─────────────────────── THE FIX: a write actually reaches S3 ───────────────────────

test('a commons write goes to S3, to the right bucket and key, when BLOB_BACKEND=s3', async () => {
  const { result, calls } = await capture(feedHandler(null), () =>
    appendShared('cto', 'fact', 'the brain can write again', ['azure-exit']),
  );

  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'a PUT must be issued -- its absence IS the bug this fixes');
  assert.ok(put!.url.startsWith(`https://${S3_BUCKET_HOST}/`), `wrong host: ${put!.url}`);
  assert.ok(
    put!.url.endsWith('/otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl'),
    `wrong key: ${put!.url}`,
  );
  assert.equal(put!.url.includes('blob.core.windows.net'), false, 'nothing may still go to Azure');

  // The entry is returned AND is what was actually written -- a write that only returns a plausible
  // object without persisting it is the failure mode this whole change is about.
  assert.equal(result?.agent, 'cto');
  assert.equal(result?.type, 'fact');
  assert.equal(result?.text, 'the brain can write again');
  const written = JSON.parse(String(put!.body).trim());
  assert.equal(written.text, 'the brain can write again');
  assert.equal(written.id, result?.id);
});

test('an append PRESERVES the existing feed rather than replacing it', async () => {
  // putText rewrites the whole JSONL file, so a read-modify-write that dropped prior rows would
  // erase a lane's entire history on its next write -- worse than the outage it replaces.
  const existing = `${JSON.stringify({ id: '20260101-001', ts: '2026-01-01T00:00:00.000Z', type: 'fact', text: 'older', tags: [], agent: 'cto' })}\n`;
  const { calls } = await capture(feedHandler(existing), () =>
    appendShared('cto', 'decision', 'newer', []),
  );
  const lines = String(calls.find((c) => c.method === 'PUT')!.body).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, 'older');
  assert.equal(JSON.parse(lines[1]).text, 'newer');
});

test('the GET that precedes the write also goes to S3, not Azure', async () => {
  const { calls } = await capture(feedHandler(null), () => appendShared('cfo', 'fact', 'x', []));
  const get = calls.find((c) => c.method === 'GET');
  assert.ok(get);
  assert.ok(get!.url.startsWith(`https://${S3_BUCKET_HOST}/`));
  assert.ok(get!.url.endsWith('/_MEMORY/_exec/cfo.jsonl'));
});

// ─────────────────────── FAILURES STAY LOUD ───────────────────────

test('a failed S3 write THROWS: appendShared must never return an entry that was not persisted', async () => {
  const { error } = await capture(
    (call) => (call.method === 'PUT' ? new Response('AccessDenied', { status: 403 }) : new Response('NoSuchKey', { status: 404 })),
    () => appendShared('cto', 'fact', 'must not be silently dropped', []),
  );
  assert.match(String(error), /s3 blob put 403/);
});

test('readSharedAll THROWS on a listing failure rather than reporting an empty shared feed', async () => {
  // The 2026-07 loud-failure contract, carried onto the S3 path unchanged. A false empty here feeds
  // memory_team, wake, memory_recall, memory_pack, entity-lookup AND the retraction filter, so it
  // both hides the fleet's history and lets retracted beliefs resurface as current truth.
  const { error } = await capture(() => new Response('AccessDenied', { status: 403 }), () => readSharedAll());
  assert.match(String(error), /s3 blob list 403/);
});

test('readSharedAll THROWS when a feed blob itself 403s, instead of treating that lane as silent', async () => {
  const listing =
    '<ListBucketResult><Contents><Key>otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl</Key>' +
    '<Size>10</Size><LastModified>2026-08-18T00:00:00.000Z</LastModified><ETag>"a"</ETag></Contents></ListBucketResult>';
  const { error } = await capture(
    (call) => (call.url.includes('list-type=2') ? new Response(listing, { status: 200 }) : new Response('AccessDenied', { status: 403 })),
    () => readSharedAll(),
  );
  assert.match(String(error), /s3 commons get 403/);
});

test('readSharedAll reads the feed back from S3, newest first', async () => {
  const listing =
    '<ListBucketResult>' +
    '<Contents><Key>otchealthcommons/company-journal/_MEMORY/_exec/cto.jsonl</Key><Size>10</Size>' +
    '<LastModified>2026-08-18T00:00:00.000Z</LastModified><ETag>"a"</ETag></Contents>' +
    // A non-.jsonl sibling (the reconcile marker) must be filtered out, exactly as on Azure.
    '<Contents><Key>otchealthcommons/company-journal/_MEMORY/_exec/cto.reconcile</Key><Size>2</Size>' +
    '<LastModified>2026-08-18T00:00:00.000Z</LastModified><ETag>"b"</ETag></Contents>' +
    '</ListBucketResult>';
  const feed =
    `${JSON.stringify({ id: '20260818-001', ts: '2026-08-18T01:00:00.000Z', type: 'fact', text: 'older', tags: [], agent: 'cto' })}\n` +
    `${JSON.stringify({ id: '20260818-002', ts: '2026-08-18T02:00:00.000Z', type: 'fact', text: 'newer', tags: [], agent: 'cto' })}\n`;

  const { result, calls } = await capture(
    (call) => (call.url.includes('list-type=2') ? new Response(listing, { status: 200 }) : new Response(feed, { status: 200 })),
    () => readSharedAll(),
  );
  assert.equal(result?.length, 2);
  assert.equal(result?.[0].text, 'newer', 'newest first');
  assert.equal(result?.[1].text, 'older');
  // Only the .jsonl was fetched; the .reconcile marker was filtered before any GET.
  assert.equal(calls.filter((c) => c.url.includes('.reconcile')).length, 0);
});

// ─────────────────────── SURVIVING THE DEAD AZURE SECRETS ───────────────────────

test('the store is CONFIGURED on S3 even with the Azure commons secrets removed', async () => {
  // isConfigured() gates every memory tool. If it kept requiring the Azure key, deleting the dead
  // secrets would make the whole memory surface answer with a soft, plausible "not configured"
  // no-op -- a quieter version of the same outage.
  assert.equal(process.env.AZURE_COMMONS_STORAGE_ACCOUNT, undefined, 'this test is only meaningful unset');
  assert.equal(process.env.AZURE_COMMONS_STORAGE_KEY, undefined);
  assert.equal(isConfigured(), true);
});

test('with no AZURE_COMMONS_STORAGE_ACCOUNT the store still resolves the right mirror row', async () => {
  // The account name is only a lookup key into the S3 allow-list, so it falls back to the hardwired
  // commons account rather than failing the mapping.
  const { calls } = await capture(feedHandler(null), () => appendShared('clo', 'fact', 'x', []));
  assert.ok(calls[0].url.includes('/otchealthcommons/company-journal/'));
  assert.ok(calls[0].url.startsWith(`https://${S3_BUCKET_HOST}/`));
});
