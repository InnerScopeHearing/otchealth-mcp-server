import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * appendShared() LOST UPDATES under concurrency (2026-08-18).
 *
 * `putText` was an unconditional whole-file read-modify-write against a store fronted by 2+ ECS
 * replicas. Two concurrent appendShared() calls on the same lane both read the same feed, both
 * append their own entry to their own in-memory copy, and whichever PUT lands second wins outright
 * -- the first writer's entry is gone, with no error anywhere, and the caller that "won" the race
 * has no way to know a sibling entry was just erased.
 *
 * This file proves the fix: appendShared now captures the ETag it read, sends it back as an S3
 * `If-Match` (or Azure `If-Match`/`If-None-Match`) precondition on the write, and on a precondition
 * failure RE-READS (picking up whatever the other writer landed) and retries -- so both entries
 * survive. Exhausting the retries THROWS; it must never return an entry that was not actually
 * persisted.
 *
 * Its own file (not an addition to store-s3.test.ts) so each scenario's exact GET/PUT sequence is
 * easy to read top to bottom without hunting through unrelated tests for shared response-sequencing
 * state.
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

const { appendShared } = await import('./store.js');

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Stub fetch with an EXACT, per-call sequence of responses -- the Nth network call gets the Nth
 * handler, and running out of handlers is a test-authoring bug (thrown loudly, not silently
 * defaulted to the last one). Deliberately NOT "cap at the last handler": capping by raw call index
 * across GET and PUT interleaved would hand a PUT's collision response to the FOLLOWING GET call
 * (and vice versa) the moment the two counts diverge, corrupting exactly the scenarios these tests
 * exist to check.
 */
async function withResponses<T>(
  responses: Array<() => Response>,
  run: () => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; calls: Seen[] }> {
  const calls: Seen[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(u),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init?.body,
    });
    if (i >= responses.length) {
      throw new Error(`withResponses: call #${i + 1} (${init?.method ?? 'GET'} ${String(u)}) has no scripted response`);
    }
    const make = responses[i];
    i++;
    return make();
  }) as unknown as typeof fetch;
  try {
    return { result: await run(), error: undefined, calls };
  } catch (error) {
    return { result: undefined, error, calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Build the exact GET/PUT response sequence for N attempts that ALL collide: read (200, some
 *  ETag), write (412), read, write, ... -- used to prove retries are bounded, not infinite. */
function alwaysCollideResponses(attempts: number): Array<() => Response> {
  const out: Array<() => Response> = [];
  for (let n = 0; n < attempts; n++) {
    out.push(() => new Response(jsonl(RIVAL), { status: 200, headers: { etag: `"v${n}"` } }));
    out.push(() => new Response('PreconditionFailed', { status: 412 }));
  }
  return out;
}

function jsonl(...rows: Array<Record<string, unknown>>): string {
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

const RIVAL = { id: '20260818-001', ts: '2026-08-18T00:00:00.000Z', type: 'fact', text: 'rival wrote first', tags: [], agent: 'cto' };

// ─────────────────────────── THE FIX: an UPDATE collision preserves both entries ───────────────────────────

test('a concurrent UPDATE collision retries and preserves the OTHER writer entry (nothing lost)', async () => {
  // Attempt 1: GET returns the feed as it was before the race, etag v1.
  // Attempt 1: PUT (If-Match: v1) collides -- a rival writer's PUT landed first and changed the ETag.
  // Attempt 2: GET re-reads and now sees the rival's entry, at the NEW etag v2.
  // Attempt 2: PUT (If-Match: v2) succeeds.
  const { result, calls } = await withResponses(
    [
      () => new Response(jsonl(RIVAL), { status: 200, headers: { etag: '"v1"' } }), // GET #1
      () => new Response('PreconditionFailed', { status: 412 }), // PUT #1 -- lost the race
      () => new Response(jsonl(RIVAL), { status: 200, headers: { etag: '"v2"' } }), // GET #2 (retry)
      () => new Response('', { status: 200, headers: { etag: '"v3"' } }), // PUT #2 -- succeeds
    ],
    () => appendShared('cto', 'fact', 'mine, appended after the retry', []),
  );

  assert.equal(result?.text, 'mine, appended after the retry', 'the call must still return ITS OWN entry');

  const gets = calls.filter((c) => c.method === 'GET');
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(gets.length, 2, 'exactly one retry: read, collide, re-read');
  assert.equal(puts.length, 2, 'exactly one retry: write, collide, re-write');

  // THE ASSERTION THAT PROVES NOTHING WAS LOST: the SECOND (successful) PUT body must contain BOTH
  // the rival's entry (picked up by the re-read) and this call's own new entry. A lost-update bug
  // would send only [mine] here, having silently dropped the rival's entry that the pre-fix code
  // never re-read after losing the race.
  const finalBody = String(puts[1].body).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(finalBody.length, 2, 'both the rival entry AND this entry must be present');
  assert.equal(finalBody[0].text, 'rival wrote first');
  assert.equal(finalBody[1].text, 'mine, appended after the retry');

  // And the retry really was CONDITIONAL, not a blind clobber: the second PUT carries the ETag from
  // the second GET, proving the write is pinned to the version actually read, not to stale state.
  assert.equal(puts[0].headers['if-match'], '"v1"', 'first attempt pins to the first ETag read');
  assert.equal(puts[1].headers['if-match'], '"v2"', 'retry pins to the FRESH ETag from the re-read');
});

// ─────────────────────────── THE FIX: a CREATE-race (first-ever write) also preserves both ───────────────────────────

test('a concurrent CREATE collision (first-ever write to the lane) also retries and preserves both entries', async () => {
  // Attempt 1: GET 404s -- this lane has never written before, so this call believes it is creating.
  // Attempt 1: PUT (If-None-Match: *) collides -- a rival writer created the object microseconds first.
  // Attempt 2: GET now finds the rival's freshly-created object, at etag v1.
  // Attempt 2: PUT (If-Match: v1) succeeds.
  const { result, calls } = await withResponses(
    [
      () => new Response('NoSuchKey', { status: 404 }), // GET #1 -- lane looks brand new
      () => new Response('PreconditionFailed', { status: 412 }), // PUT #1 -- someone else created it first
      () => new Response(jsonl(RIVAL), { status: 200, headers: { etag: '"v1"' } }), // GET #2 (retry)
      () => new Response('', { status: 200, headers: { etag: '"v2"' } }), // PUT #2 -- succeeds
    ],
    () => appendShared('cto', 'fact', 'mine, second to create', []),
  );

  assert.equal(result?.text, 'mine, second to create');

  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 2);
  // The FIRST attempt (believing the lane was empty) must be a create-only guard, not a blind write.
  assert.equal(puts[0].headers['if-none-match'], '*', 'first attempt guards against a concurrent create');
  assert.equal(puts[0].headers['if-match'], undefined);
  // The RETRY, now that the object demonstrably exists, pins to the rival's ETag instead.
  assert.equal(puts[1].headers['if-match'], '"v1"');
  assert.equal(puts[1].headers['if-none-match'], undefined);

  const finalBody = String(puts[1].body).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(finalBody.length, 2, 'the rival that won the create race must not be erased');
  assert.equal(finalBody[0].text, 'rival wrote first');
  assert.equal(finalBody[1].text, 'mine, second to create');
});

// ─────────────────────────── Exhausting retries THROWS, never a fabricated success ───────────────────────────

test('sustained collision exhausts the bounded retries and THROWS -- never returns an unpersisted entry', async () => {
  // Every single PUT collides. Headroom of 12 attempts (well above any reasonable retry bound) so
  // this proves boundedness rather than merely matching whatever the current constant happens to be.
  const { result, error, calls } = await withResponses(alwaysCollideResponses(12), () =>
    appendShared('cto', 'fact', 'never actually lands', []),
  );

  assert.equal(result, undefined, 'no entry is returned when the write never actually persisted');
  assert.match(String(error), /lost the write race/);
  assert.match(String(error), /was NOT saved/);
  // Bounded: this must not have looped forever or retried some huge number of times.
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.ok(puts.length >= 2 && puts.length <= 10, `expected a small bounded number of attempts, got ${puts.length}`);
});

// ─────────────────────────── A real (non-conflict) failure is NEVER retried ───────────────────────────

test('a genuine write failure (403) is NOT treated as a retryable collision', async () => {
  const { error, calls } = await withResponses(
    [
      () => new Response(jsonl(RIVAL), { status: 200, headers: { etag: '"v1"' } }), // GET
      () => new Response('AccessDenied', { status: 403 }), // PUT -- a real permissions failure
    ],
    () => appendShared('cto', 'fact', 'blocked by a real failure', []),
  );
  assert.match(String(error), /s3 blob put 403/);
  const puts = calls.filter((c) => c.method === 'PUT');
  assert.equal(puts.length, 1, 'a non-conflict failure must not be retried at all');
});

// ─────────────────────────── The uncontended path still writes exactly once ───────────────────────────

test('with no collision, appendShared does exactly one GET and one PUT (no needless retry overhead)', async () => {
  const { result, calls } = await withResponses(
    [
      () => new Response('NoSuchKey', { status: 404 }),
      () => new Response('', { status: 200, headers: { etag: '"v1"' } }),
    ],
    () => appendShared('cto', 'fact', 'uncontended', []),
  );
  assert.equal(result?.text, 'uncontended');
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
});
