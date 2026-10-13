import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntercomOperationsClient, IntercomOperationError } from './operations-client.js';

test('operation client pins region/version and safely interpolates a path segment', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  let budgetRetries = -1;
  const client = createIntercomOperationsClient({
    baseUrl: 'https://api.eu.intercom.io',
    accessToken: 'test-secret',
    fetcher: async (url, init, budget) => {
      requestUrl = String(url);
      requestInit = init;
      budgetRetries = budget?.retries ?? -1;
      return new Response('{"id":"macro-1"}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.executeOperation({ operation_id: 'getMacro', path_params: { id: 'macro-1' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { id: 'macro-1' });
  assert.equal(requestUrl, 'https://api.eu.intercom.io/macros/macro-1');
  assert.equal((requestInit?.headers as Record<string, string>)['intercom-version'], '2.17');
  assert.equal((requestInit?.headers as Record<string, string>).authorization, 'Bearer test-secret');
  assert.equal(budgetRetries, 1);
});

test('write operations are never automatically retried', async () => {
  let retries = -1;
  let calls = 0;
  const client = createIntercomOperationsClient({
    accessToken: 'test-secret',
    fetcher: async (_url, _init, budget) => {
      calls += 1;
      retries = budget?.retries ?? -1;
      return new Response('provider failure secret', { status: 503 });
    },
  });
  await assert.rejects(
    client.executeOperation({ operation_id: 'SearchContacts', body: { query: { field: 'email', operator: '=', value: 'x@y.z' } } }),
    (error: unknown) => error instanceof IntercomOperationError && error.code === 'provider_rejected_request' && !error.message.includes('secret'),
  );
  assert.equal(retries, 0);
  assert.equal(calls, 1);
});

test('invalid host and path traversal fail before a provider call', async () => {
  assert.throws(() => createIntercomOperationsClient({ baseUrl: 'https://example.com' }), IntercomOperationError);
  let called = false;
  const client = createIntercomOperationsClient({ accessToken: 'test-secret', fetcher: async () => { called = true; return new Response('{}'); } });
  await assert.rejects(client.executeOperation({ operation_id: 'getMacro', path_params: { id: '../contacts' } }), IntercomOperationError);
  assert.equal(called, false);
});

test('Fin runtime selects its dedicated token when configured', async () => {
  let authorization = '';
  let sentUrl = '';
  const client = createIntercomOperationsClient({
    accessToken: 'general-secret',
    finAccessToken: 'fin-secret',
    fetcher: async (url, init) => {
      sentUrl = String(url);
      authorization = (init?.headers as Record<string, string>).authorization;
      return new Response('{}', { status: 200 });
    },
  });
  await client.executeOperation({ operation_id: 'listFinCapabilities', body: { user: { id: 'user-1' } } });
  assert.equal(sentUrl, 'https://api.intercom.io/fin/capabilities');
  assert.equal(authorization, 'Bearer fin-secret');
});

test('documented transcript response is returned as text', async () => {
  const client = createIntercomOperationsClient({
    accessToken: 'test-secret',
    fetcher: async () => new Response('transcript contents', { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  const result = await client.executeOperation({ operation_id: 'showCallTranscript', path_params: { call_id: '12' } });
  assert.equal(result.data, 'transcript contents');
});

test('provider response streams are capped at 1 MiB', async () => {
  let cancelled = false;
  const client = createIntercomOperationsClient({
    accessToken: 'test-secret',
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  });
  await assert.rejects(
    client.executeOperation({ operation_id: 'getMacro', path_params: { id: 'macro-1' } }),
    (error: unknown) => error instanceof IntercomOperationError && error.code === 'provider_response_too_large',
  );
  assert.equal(cancelled, true);
});
