import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../server/request-context.js';

// Pins the 2026-08-04 CFO FY2021-close regression fix: graph_list_messages/graph_message_get
// resolve mailboxes on GRAPH_EXEC_MAILBOXES through a SEPARATE, non-CS-restricted app for
// EXEC_RING callers only. The CS allowlist/app/policy is completely unaffected by this -- these
// tests exist to make sure a future edit can't silently widen the exec path to a non-exec lane or
// an unlisted mailbox, or narrow it back to nothing.

before(() => {
  process.env.CIO_SITE_ID ??= 'test';
  process.env.CIO_TRACK_KEY ??= 'test';
  process.env.CIO_APP_API_BEARER ??= 'test';
  process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'a'.repeat(32);
  process.env.ADMIN_REVOKE_TOKEN ??= 'b'.repeat(32);
  process.env.N8N_WEBHOOK_SECRET ??= 'c'.repeat(32);
  process.env.GRAPH_TENANT_ID ??= 'test-tenant';
  process.env.GRAPH_CLIENT_ID ??= 'test-client';
  process.env.GRAPH_CLIENT_SECRET ??= 'test-secret';
});

// listMessages: $search / contains()-drops-orderby / until / has_attachments (#290).
//
// Root cause this pins: listMessages ALWAYS set $orderby=receivedDateTime desc, and Graph
// rejects (a) $search combined with $filter or $orderby at all, and (b) a $filter using
// contains()/startswith() combined with $orderby (InefficientFilter, "restriction too complex").
// These tests stub globalThis.fetch directly (same pattern as src/util/fetch-budget.test.ts --
// this repo's ESM build does not let node:test's mock.method() override another module's live
// named export, but globalThis.fetch is a genuine global) and assert on the actual request URL/
// headers built by listMessages, plus the client-side sort it falls back to whenever $orderby is
// dropped.

async function withStubbedGraphFetch<T>(
  handler: (url: string, init: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init });
    if (urlStr.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }), { status: 200 });
    }
    return handler(urlStr, init);
  }) as typeof fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

function messagesResponse(messages: Array<{ id: string; receivedDateTime: string }>): Response {
  return new Response(JSON.stringify({ value: messages }), { status: 200 });
}

// URLSearchParams#toString() form-encodes spaces as '+', which plain decodeURIComponent does NOT
// turn back into ' ' -- replace '+' first, same as any application/x-www-form-urlencoded decode.
function decodeFormValue(raw: string): string {
  return decodeURIComponent(raw.replace(/\+/g, ' '));
}

test('listMessages: search sets $search (quoted) with no $filter/$orderby, ConsistencyLevel header, and sorts client-side', async () => {
  const { listMessages } = await import('./api-client.js');
  const { calls, result } = await withStubbedGraphFetch(
    () => messagesResponse([
      { id: 'older', receivedDateTime: '2026-01-01T00:00:00Z' },
      { id: 'newer', receivedDateTime: '2026-06-01T00:00:00Z' },
    ]),
    () => listMessages({ mailbox: 'coo@otchealthmart.com', search: 'subject:statement hasAttachments:true' }),
  );
  const graphCall = calls.find((c) => c.url.includes('graph.microsoft.com'));
  assert.ok(graphCall, 'expected a call to graph.microsoft.com');
  assert.ok(graphCall!.url.includes('%24search=%22subject%3Astatement+hasAttachments%3Atrue%22'), `unexpected url: ${graphCall!.url}`);
  assert.equal(graphCall!.url.includes('%24filter'), false, '$search must not be combined with $filter');
  assert.equal(graphCall!.url.includes('%24orderby'), false, '$search must not be combined with $orderby');
  const headers = graphCall!.init.headers as Record<string, string>;
  assert.equal(headers.ConsistencyLevel, 'eventual');
  // Client-side sort: newer first even though the stub returned older first.
  assert.deepEqual(result.map((m: any) => m.id), ['newer', 'older']);
});

test('listMessages: subject_contains appends contains() to $filter and drops $orderby, sorting client-side', async () => {
  const { listMessages } = await import('./api-client.js');
  const { calls, result } = await withStubbedGraphFetch(
    () => messagesResponse([
      { id: 'older', receivedDateTime: '2026-01-01T00:00:00Z' },
      { id: 'newer', receivedDateTime: '2026-06-01T00:00:00Z' },
    ]),
    () => listMessages({ mailbox: 'coo@otchealthmart.com', subjectContains: "O'Brien invoice" }),
  );
  const graphCall = calls.find((c) => c.url.includes('graph.microsoft.com'));
  const decodedFilter = decodeFormValue(graphCall!.url.split('%24filter=')[1]?.split('&')[0] ?? '');
  assert.equal(decodedFilter, "contains(subject,'O''Brien invoice')", 'single quotes must be doubled');
  assert.equal(graphCall!.url.includes('%24orderby'), false, 'contains() + $orderby is InefficientFilter -- orderby must be dropped');
  assert.deepEqual(result.map((m: any) => m.id), ['newer', 'older']);
});

test('listMessages: from_contains behaves the same as subject_contains (drops $orderby, client sort)', async () => {
  const { listMessages } = await import('./api-client.js');
  const { calls } = await withStubbedGraphFetch(
    () => messagesResponse([{ id: 'a', receivedDateTime: '2026-01-01T00:00:00Z' }]),
    () => listMessages({ mailbox: 'coo@otchealthmart.com', fromContains: 'billing@vendor.com' }),
  );
  const graphCall = calls.find((c) => c.url.includes('graph.microsoft.com'));
  const decodedFilter = decodeFormValue(graphCall!.url.split('%24filter=')[1]?.split('&')[0] ?? '');
  assert.equal(decodedFilter, "contains(from/emailAddress/address,'billing@vendor.com')");
  assert.equal(graphCall!.url.includes('%24orderby'), false);
});

test('listMessages: a raw `filter` using contains(/startswith( also drops $orderby, even without subject_contains/from_contains', async () => {
  const { listMessages } = await import('./api-client.js');
  const { calls } = await withStubbedGraphFetch(
    () => messagesResponse([{ id: 'a', receivedDateTime: '2026-01-01T00:00:00Z' }]),
    () => listMessages({ mailbox: 'coo@otchealthmart.com', filter: "startswith(subject,'RE:')" }),
  );
  const graphCall = calls.find((c) => c.url.includes('graph.microsoft.com'));
  assert.equal(graphCall!.url.includes('%24orderby'), false, 'raw filter using startswith( must also force client-side sort');
});

test('listMessages: has_attachments and until stay indexed $filter clauses, and $orderby is kept', async () => {
  const { listMessages } = await import('./api-client.js');
  const { calls } = await withStubbedGraphFetch(
    () => messagesResponse([{ id: 'a', receivedDateTime: '2026-01-01T00:00:00Z' }]),
    () => listMessages({ mailbox: 'coo@otchealthmart.com', hasAttachments: true, until: '2026-06-01T00:00:00Z', since: '2026-01-01T00:00:00Z' }),
  );
  const graphCall = calls.find((c) => c.url.includes('graph.microsoft.com'));
  const decodedFilter = decodeFormValue(graphCall!.url.split('%24filter=')[1]?.split('&')[0] ?? '');
  assert.equal(decodedFilter, 'receivedDateTime ge 2026-01-01T00:00:00Z and receivedDateTime le 2026-06-01T00:00:00Z and hasAttachments eq true');
  assert.ok(graphCall!.url.includes('%24orderby=receivedDateTime+desc'), 'indexed-only filter should keep $orderby');
});

function asCaller<T>(callerAgent: string, fn: () => T): T {
  return requestContext.run(
    { callerHash: 'test', correlationId: 'test', callerAgent },
    fn,
  );
}

test('execAllowedMailboxes: defaults to the 4 named exec mailboxes from the CFO request', async () => {
  const { execAllowedMailboxes } = await import('./api-client.js');
  const set = execAllowedMailboxes();
  assert.ok(set.has('matthew@innd.com'));
  assert.ok(set.has('ap@innd.com'));
  assert.ok(set.has('accounting@hearingassist.com'));
  assert.ok(set.has('cfo@innd.com'));
  // Never defaults to a CS mailbox -- the two allowlists must stay disjoint in intent.
  assert.equal(set.has('care@otchealthmart.com'), false);
});

test('isExecMailboxRequest: true for an EXEC_RING caller asking for a listed exec mailbox', async () => {
  const { isExecMailboxRequest } = await import('./api-client.js');
  for (const lane of ['cfo', 'clo', 'cpo', 'cco', 'exec']) {
    assert.equal(asCaller(lane, () => isExecMailboxRequest('matthew@innd.com')), true, `${lane} should reach matthew@innd.com`);
    assert.equal(asCaller(lane, () => isExecMailboxRequest('MATTHEW@INND.COM')), true, 'case-insensitive');
  }
});

test('isExecMailboxRequest: false for a non-EXEC_RING caller, even on a listed mailbox', async () => {
  const { isExecMailboxRequest } = await import('./api-client.js');
  for (const lane of ['cto', 'developer', 'cro', 'coo', '', 'randostring']) {
    assert.equal(asCaller(lane, () => isExecMailboxRequest('matthew@innd.com')), false, `${lane} must NOT get the exec mail path`);
  }
});

test('isExecMailboxRequest: false for an EXEC_RING caller on a mailbox NOT on the exec list (incl. CS mailboxes)', async () => {
  const { isExecMailboxRequest } = await import('./api-client.js');
  assert.equal(asCaller('cfo', () => isExecMailboxRequest('care@otchealthmart.com')), false);
  assert.equal(asCaller('cfo', () => isExecMailboxRequest('ceo@innd.com')), false);
  assert.equal(asCaller('clo', () => isExecMailboxRequest('someone-else@innd.com')), false);
});
