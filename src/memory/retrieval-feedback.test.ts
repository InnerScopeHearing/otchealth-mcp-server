import { test } from 'node:test';
import assert from 'node:assert/strict';

// Satisfy loadEnv()'s truly-required vars, and set a PostHog Gateway Ops key BEFORE anything in
// this file's process ever calls loadEnv() -- loadEnv() caches its parse result for the lifetime
// of the process (see config/env.ts's `if (cached) return cached;`), so a later `process.env.X =`
// assignment has NO effect once something has already loaded the env once. Mirrors the same
// caching note in kb/brain-search.test.ts's preamble. node:test runs each file in its own process
// by default, so this does not leak into other test files.
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.POSTHOG_GATEWAYOPS_KEY ||= 'phc_test_key';

import {
  REFERENCE_PREFIX,
  MAX_QUERY_CHARS,
  MAX_HITID_CHARS,
  DEFAULT_REF_TTL_MS,
  buildFeedbackRef,
  parseFeedbackRef,
  isFeedbackRefFresh,
  tagWithFeedbackRefs,
  isFeedbackRating,
  FEEDBACK_RATINGS,
  RETRIEVAL_FEEDBACK_EVENT,
  sanitizeReason,
  buildFeedbackEventProperties,
  recordRetrievalFeedback,
  type ReferenceFields,
} from './retrieval-feedback.js';

// ---- buildFeedbackRef / parseFeedbackRef (the reference-id core) ------------------------------

test('buildFeedbackRef -> parseFeedbackRef: roundtrips exactly for a normal hit', () => {
  const ref = buildFeedbackRef({ tool: 'brain_search', room: 'memory-exec', hitId: 'cto__abc123', query: 'what is the ASC key id', now: 1_700_000_000_000 });
  assert.ok(ref.startsWith(REFERENCE_PREFIX));
  const parsed = parseFeedbackRef(ref);
  assert.deepEqual(parsed, {
    tool: 'brain_search',
    room: 'memory-exec',
    hitId: 'cto__abc123',
    query: 'what is the ASC key id',
    ts: 1_700_000_000_000,
  });
});

test('buildFeedbackRef: deterministic -- the same input (including the same `now`) always produces the same ref', () => {
  const input = { tool: 'kb_search', room: 'commons-company-journal', hitId: 'x1', query: 'q', now: 123 };
  assert.equal(buildFeedbackRef(input), buildFeedbackRef(input));
});

test('buildFeedbackRef: defaults `now` to the current clock when omitted', () => {
  const before = Date.now();
  const ref = buildFeedbackRef({ tool: 'kb_search', room: 'r', hitId: 'i', query: 'q' });
  const after = Date.now();
  const parsed = parseFeedbackRef(ref);
  assert.ok(parsed);
  assert.ok(parsed!.ts >= before && parsed!.ts <= after);
});

test('buildFeedbackRef: a non-string hit id (object/number) is stringified, never crashes', () => {
  const ref1 = buildFeedbackRef({ tool: 't', room: 'r', hitId: { doc: 'a1', chunk: 2 }, query: 'q', now: 1 });
  const parsed1 = parseFeedbackRef(ref1);
  assert.ok(parsed1);
  assert.match(parsed1!.hitId, /"doc":"a1"/);

  const ref2 = buildFeedbackRef({ tool: 't', room: 'r', hitId: 42, query: 'q', now: 1 });
  assert.equal(parseFeedbackRef(ref2)!.hitId, '42');
});

test('buildFeedbackRef: undefined/null hit id becomes the literal "unknown", never throws', () => {
  assert.equal(parseFeedbackRef(buildFeedbackRef({ tool: 't', room: 'r', hitId: undefined, query: 'q', now: 1 }))!.hitId, 'unknown');
  assert.equal(parseFeedbackRef(buildFeedbackRef({ tool: 't', room: 'r', hitId: null, query: 'q', now: 1 }))!.hitId, 'unknown');
});

test('buildFeedbackRef: an overlong query is truncated to MAX_QUERY_CHARS', () => {
  const long = 'q'.repeat(MAX_QUERY_CHARS + 500);
  const parsed = parseFeedbackRef(buildFeedbackRef({ tool: 't', room: 'r', hitId: 'i', query: long, now: 1 }));
  assert.equal(parsed!.query.length, MAX_QUERY_CHARS);
});

test('buildFeedbackRef: an overlong hit id is truncated to MAX_HITID_CHARS', () => {
  const long = 'x'.repeat(MAX_HITID_CHARS + 500);
  const parsed = parseFeedbackRef(buildFeedbackRef({ tool: 't', room: 'r', hitId: long, query: 'q', now: 1 }));
  assert.equal(parsed!.hitId.length, MAX_HITID_CHARS);
});

test('buildFeedbackRef: the ref carries only ids/names/query, never any content field', () => {
  const ref = buildFeedbackRef({ tool: 'brain_search', room: 'memory-exec', hitId: 'id1', query: 'q', now: 1 });
  const json = Buffer.from(ref.slice(REFERENCE_PREFIX.length), 'base64url').toString('utf8');
  const keys = Object.keys(JSON.parse(json)).sort();
  assert.deepEqual(keys, ['hitId', 'query', 'room', 'tool', 'ts']);
});

test('parseFeedbackRef: rejects non-string, empty, and oversized input without throwing', () => {
  assert.equal(parseFeedbackRef(undefined), null);
  assert.equal(parseFeedbackRef(null), null);
  assert.equal(parseFeedbackRef(42), null);
  assert.equal(parseFeedbackRef({}), null);
  assert.equal(parseFeedbackRef(''), null);
  assert.equal(parseFeedbackRef('x'.repeat(5000)), null);
});

test('parseFeedbackRef: rejects a wrong prefix, garbage base64, and truncated JSON', () => {
  assert.equal(parseFeedbackRef('not-the-right-prefix_abc'), null);
  assert.equal(parseFeedbackRef(`${REFERENCE_PREFIX}!!!not-base64!!!`), null);
  const half = buildFeedbackRef({ tool: 't', room: 'r', hitId: 'i', query: 'q', now: 1 }).slice(0, 12);
  assert.equal(parseFeedbackRef(half), null);
});

test('parseFeedbackRef: rejects well-formed JSON missing a required field, or with a wrong type', () => {
  const encode = (obj: unknown) => `${REFERENCE_PREFIX}${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`;
  assert.equal(parseFeedbackRef(encode({ tool: 't', room: 'r', hitId: 'i', query: 'q' /* missing ts */ })), null);
  assert.equal(parseFeedbackRef(encode({ tool: 't', room: 'r', hitId: 'i', query: 'q', ts: 'not-a-number' })), null);
  assert.equal(parseFeedbackRef(encode({ tool: 1, room: 'r', hitId: 'i', query: 'q', ts: 1 })), null);
  assert.equal(parseFeedbackRef(encode({ tool: 't', room: 'r', hitId: 'i', query: 'q', ts: Number.NaN })), null);
  assert.equal(parseFeedbackRef(encode(null)), null);
  assert.equal(parseFeedbackRef(encode([1, 2, 3])), null);
});

// ---- isFeedbackRefFresh ("short-lived", informational only) -----------------------------------

test('isFeedbackRefFresh: true within the TTL window, false past it, boundary is inclusive', () => {
  const ref: ReferenceFields = { tool: 't', room: 'r', hitId: 'i', query: 'q', ts: 1000 };
  assert.equal(isFeedbackRefFresh(ref, 1000 + DEFAULT_REF_TTL_MS - 1), true);
  assert.equal(isFeedbackRefFresh(ref, 1000 + DEFAULT_REF_TTL_MS), true, 'exactly at the TTL boundary is still fresh (<=)');
  assert.equal(isFeedbackRefFresh(ref, 1000 + DEFAULT_REF_TTL_MS + 1), false);
});

// ---- tagWithFeedbackRefs (stamping a batch of hits) --------------------------------------------

test('tagWithFeedbackRefs: kb_search-shaped hits (no per-hit source) use the caller-supplied defaultRoom', () => {
  const hits = [{ id: 'a1', text: 'hit a', score: 1.2 }, { id: 'a2', text: 'hit b', score: 0.9 }];
  const tagged = tagWithFeedbackRefs(hits, { tool: 'kb_search', query: 'q', defaultRoom: 'memory-exec', now: 5 });
  assert.equal(tagged.length, 2);
  for (const h of tagged) {
    assert.equal(typeof h.feedback_ref, 'string');
    const parsed = parseFeedbackRef(h.feedback_ref);
    assert.equal(parsed!.room, 'memory-exec');
    assert.equal(parsed!.tool, 'kb_search');
  }
  assert.equal(parseFeedbackRef(tagged[0]!.feedback_ref)!.hitId, 'a1');
  assert.equal(parseFeedbackRef(tagged[1]!.feedback_ref)!.hitId, 'a2');
});

test('tagWithFeedbackRefs: brain_search-shaped hits (per-hit `source`) use their OWN room, not the default', () => {
  const hits = [
    { id: 'e1', source: 'finance-cfo-source-docs', text: 'x', score: 1 },
    { id: 'e2', source: 'legal-company', text: 'y', score: 1 },
  ];
  const tagged = tagWithFeedbackRefs(hits, { tool: 'brain_search', query: 'q', defaultRoom: 'federated', now: 5 });
  assert.equal(parseFeedbackRef(tagged[0]!.feedback_ref)!.room, 'finance-cfo-source-docs');
  assert.equal(parseFeedbackRef(tagged[1]!.feedback_ref)!.room, 'legal-company');
});

test('tagWithFeedbackRefs: a hit with no `source` at all (e.g. the synthetic entity-answer row) falls back to defaultRoom', () => {
  const hits = [{ id: 'ent1', text: 'answer', score: Number.POSITIVE_INFINITY, type: 'entity', authoritative: true }];
  const tagged = tagWithFeedbackRefs(hits, { tool: 'brain_search', query: 'q', defaultRoom: 'federated', now: 5 });
  assert.equal(parseFeedbackRef(tagged[0]!.feedback_ref)!.room, 'federated');
});

test('tagWithFeedbackRefs: preserves every original field on the hit, only ADDS feedback_ref', () => {
  const hits = [{ id: 'a1', text: 'hit a', score: 1.2, path: 'docs/x.pdf' }];
  const tagged = tagWithFeedbackRefs(hits, { tool: 'kb_search', query: 'q', defaultRoom: 'r', now: 1 });
  assert.equal(tagged[0]!.id, 'a1');
  assert.equal(tagged[0]!.text, 'hit a');
  assert.equal(tagged[0]!.score, 1.2);
  assert.equal(tagged[0]!.path, 'docs/x.pdf');
});

test('tagWithFeedbackRefs: an empty hit array tags to an empty array', () => {
  assert.deepEqual(tagWithFeedbackRefs([], { tool: 't', query: 'q', defaultRoom: 'r' }), []);
});

// ---- isFeedbackRating / FEEDBACK_RATINGS --------------------------------------------------------

test('isFeedbackRating: accepts exactly the three declared ratings', () => {
  for (const r of FEEDBACK_RATINGS) assert.equal(isFeedbackRating(r), true);
  assert.deepEqual([...FEEDBACK_RATINGS].sort(), ['cited', 'not_useful', 'useful']);
});

test('isFeedbackRating: rejects anything else, including near-miss strings and non-strings', () => {
  for (const bad of ['Useful', 'useless', '', 'usefull', 42, null, undefined, {}]) {
    assert.equal(isFeedbackRating(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// ---- sanitizeReason -------------------------------------------------------------------------------

test('sanitizeReason: undefined/empty/whitespace-only all become undefined', () => {
  assert.equal(sanitizeReason(undefined), undefined);
  assert.equal(sanitizeReason(''), undefined);
  assert.equal(sanitizeReason('   '), undefined);
});

test('sanitizeReason: an ordinary short reason survives trimmed', () => {
  assert.equal(sanitizeReason('  it directly answered the question  '), 'it directly answered the question');
});

test('sanitizeReason: an overlong reason is truncated', () => {
  const long = 'word '.repeat(200);
  const out = sanitizeReason(long);
  assert.ok(out!.length < long.length);
});

test('sanitizeReason: a secret-shaped reason (reuses journal.ts looksLikeSecretValue) is fully redacted, not just truncated', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(sanitizeReason(jwt), '[REDACTED]');
});

// ---- buildFeedbackEventProperties (the pure event-shape builder) -------------------------------

test('buildFeedbackEventProperties: builds the full expected shape from a decoded ref', () => {
  const ref: ReferenceFields = { tool: 'brain_search', room: 'memory-exec', hitId: 'h1', query: 'q', ts: 1000 };
  const props = buildFeedbackEventProperties({ ref, rating: 'useful', now: 1500 });
  assert.equal(props.tool, 'brain_search');
  assert.equal(props.room, 'memory-exec');
  assert.equal(props.hit_id, 'h1');
  assert.equal(props.query, 'q');
  assert.equal(props.rating, 'useful');
  assert.equal(props.ref_issued_ms, 1000);
  assert.equal(props.ref_age_ms, 500);
  assert.equal(props.ref_fresh, true);
  assert.equal('reason' in props, false, 'no reason field when none was given');
});

test('buildFeedbackEventProperties: ref_fresh flips to false once age exceeds DEFAULT_REF_TTL_MS', () => {
  const ref: ReferenceFields = { tool: 't', room: 'r', hitId: 'i', query: 'q', ts: 0 };
  const props = buildFeedbackEventProperties({ ref, rating: 'not_useful', now: DEFAULT_REF_TTL_MS + 1 });
  assert.equal(props.ref_fresh, false);
});

test('buildFeedbackEventProperties: includes a sanitized reason when one is given', () => {
  const ref: ReferenceFields = { tool: 't', room: 'r', hitId: 'i', query: 'q', ts: 0 };
  const props = buildFeedbackEventProperties({ ref, rating: 'cited', reason: '  matched the exact question  ', now: 0 });
  assert.equal(props.reason, 'matched the exact question');
});

test('buildFeedbackEventProperties: age never goes negative on a clock anomaly (now before ts)', () => {
  const ref: ReferenceFields = { tool: 't', room: 'r', hitId: 'i', query: 'q', ts: 1000 };
  const props = buildFeedbackEventProperties({ ref, rating: 'useful', now: 500 });
  assert.equal(props.ref_age_ms, 0);
});

test('buildFeedbackEventProperties: deterministic -- same input (including the same now) always produces the same output', () => {
  const ref: ReferenceFields = { tool: 't', room: 'r', hitId: 'i', query: 'q', ts: 1000 };
  const a = buildFeedbackEventProperties({ ref, rating: 'useful', now: 2000 });
  const b = buildFeedbackEventProperties({ ref, rating: 'useful', now: 2000 });
  assert.deepEqual(a, b);
});

// ---- recordRetrievalFeedback (the fire-and-forget IO shell, extending captureGatewayEvent) -----
// Mirrors the fire-and-forget conventions this repo already exercises for captureGatewayEvent-based
// emits (telemetry/gateway-ops.test.ts asserts on buildCapturePayload's shape; this proves the
// WRAPPER around the network call itself never throws, the defense-in-depth journal.ts's header
// describes for its own call site's `.catch()`).

test('recordRetrievalFeedback: never throws synchronously, even when the underlying fetch throws (defense in depth)', () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('simulated network failure');
  }) as unknown as typeof fetch;
  try {
    const ref: ReferenceFields = { tool: 'brain_search', room: 'memory-exec', hitId: 'h1', query: 'q', ts: Date.now() };
    assert.doesNotThrow(() => recordRetrievalFeedback({ ref, rating: 'useful', caller: 'cto' }));
  } finally {
    globalThis.fetch = original;
  }
});

test('recordRetrievalFeedback: never throws when fetch returns a rejected promise either', () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('simulated rejection'))) as unknown as typeof fetch;
  try {
    const ref: ReferenceFields = { tool: 'kb_search', room: 'commons-company-journal', hitId: 'h2', query: 'q', ts: Date.now() };
    assert.doesNotThrow(() => recordRetrievalFeedback({ ref, rating: 'not_useful' }));
  } finally {
    globalThis.fetch = original;
  }
});

test('recordRetrievalFeedback: is genuinely fire-and-forget -- returns before the stubbed network call settles', () => {
  const original = globalThis.fetch;
  let fetchWasCalled = false;
  globalThis.fetch = ((..._args: unknown[]) => {
    fetchWasCalled = true;
    // Never resolves within this test -- if recordRetrievalFeedback awaited this, the test itself
    // would hang; it returning at all (node:test's default per-test timeout aside) proves it didn't.
    return new Promise(() => {});
  }) as unknown as typeof fetch;
  try {
    const ref: ReferenceFields = { tool: 'brain_search', room: 'memory-exec', hitId: 'h3', query: 'q', ts: Date.now() };
    const returned = recordRetrievalFeedback({ ref, rating: 'cited' });
    assert.equal(returned, undefined, 'synchronous void return, nothing to await');
    assert.equal(fetchWasCalled, true, 'sanity: the stub really was reached (key is configured in this file)');
  } finally {
    globalThis.fetch = original;
  }
});

test('sanity: RETRIEVAL_FEEDBACK_EVENT is the stable event name a future consumption pass would query for', () => {
  assert.equal(RETRIEVAL_FEEDBACK_EVENT, 'gw_retrieval_feedback');
});
