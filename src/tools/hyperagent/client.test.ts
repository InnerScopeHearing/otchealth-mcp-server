import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callHyperagentTool, type HyperagentClientDeps } from './client.js';

// Every request and token operation is injected. No environment credentials or live services.
const OLD_TOKEN = 'synthetic-rejected-access';
const NEW_TOKEN = 'synthetic-replacement-access';
const successBody = JSON.stringify({ result: { content: [{ type: 'text', text: '{"id":"synthetic-result"}' }] } });

function harness(
  responses: Array<{ status: number; body?: string } | Error>,
  tokens: Array<string | null | Error> = [OLD_TOKEN, NEW_TOKEN],
) {
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
  const tokenRequests: Array<{ rejectedAccessToken?: string } | undefined> = [];
  const deps: HyperagentClientDeps = {
    getAccessToken: async (opts) => {
      tokenRequests.push(opts);
      const result = tokens[tokenRequests.length - 1];
      assert.notEqual(result, undefined, 'unexpected token lookup');
      if (result instanceof Error) throw result;
      return result;
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
      const response = responses[requests.length - 1];
      assert.ok(response, 'unexpected transport replay');
      if (response instanceof Error) throw response;
      return new Response(response.body ?? successBody, { status: response.status });
    },
  };
  return { deps, requests, tokenRequests };
}

for (const name of ['list_agents', 'list_threads', 'get_thread']) {
  test(`${name} retries one HTTP 401 with the replacement and identical request body`, async () => {
    const h = harness([{ status: 401, body: 'ignored provider diagnostic' }, { status: 200 }]);
    const result = await callHyperagentTool(name, { threadId: 'synthetic-thread' }, h.deps);
    assert.deepEqual(result, { ok: true, status: 200, data: { id: 'synthetic-result' } });
    assert.deepEqual(h.tokenRequests, [undefined, { rejectedAccessToken: OLD_TOKEN }]);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests.map((r) => r.authorization), [`Bearer ${OLD_TOKEN}`, `Bearer ${NEW_TOKEN}`]);
    assert.ok(h.requests.every((r) => r.url === 'https://hyperagent.com/api/mcp'));
    assert.equal(h.requests[0].body, h.requests[1].body);
    assert.deepEqual(JSON.parse(h.requests[1].body), {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { threadId: 'synthetic-thread' } },
    });
  });
}

test('a second HTTP 401 terminates without another refresh or replay', async () => {
  const h = harness([{ status: 401 }, { status: 401, body: 'private diagnostic must not be returned' }]);
  assert.deepEqual(await callHyperagentTool('get_thread', {}, h.deps), {
    ok: false, status: 401, data: null, error: 'HTTP 401',
  });
  assert.equal(h.requests.length, 2);
  assert.equal(h.tokenRequests.length, 2);
});

for (const name of ['create_thread', 'send_message', 'hyperagent_get_thread', 'unknown_tool']) {
  test(`${name} does not replay or refresh on HTTP 401`, async () => {
    const h = harness([{ status: 401 }]);
    assert.deepEqual(await callHyperagentTool(name, { message: 'synthetic mutation' }, h.deps), {
      ok: false, status: 401, data: null, error: 'HTTP 401',
    });
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.tokenRequests, [undefined]);
  });
}

for (const status of [403, 429, 500]) {
  test(`HTTP ${status} is returned without refresh or replay`, async () => {
    const h = harness([{ status }]);
    assert.deepEqual(await callHyperagentTool('get_thread', {}, h.deps), {
      ok: false, status, data: null, error: `HTTP ${status}`,
    });
    assert.equal(h.requests.length, 1);
    assert.equal(h.tokenRequests.length, 1);
  });
}

test('an HTTP 200 JSON-RPC error does not trigger authentication recovery', async () => {
  const h = harness([{ status: 200, body: JSON.stringify({ error: { message: 'synthetic failure' } }) }]);
  assert.deepEqual(await callHyperagentTool('get_thread', {}, h.deps), {
    ok: false, status: 200, data: null, error: 'synthetic failure',
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.tokenRequests.length, 1);
});

test('an uncertain transport failure is not replayed', async () => {
  const h = harness([new Error('synthetic connection reset')]);
  await assert.rejects(callHyperagentTool('get_thread', {}, h.deps), /synthetic connection reset/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.tokenRequests.length, 1);
});

test('refresh failure prevents retry', async () => {
  const h = harness([{ status: 401 }], [OLD_TOKEN, new Error('synthetic consent required')]);
  await assert.rejects(callHyperagentTool('get_thread', {}, h.deps), /synthetic consent required/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.tokenRequests.length, 2);
});

for (const replacement of [null, OLD_TOKEN]) {
  test(`no replay without a different replacement token (${replacement === null ? 'null' : 'unchanged'})`, async () => {
    const h = harness([{ status: 401 }], [OLD_TOKEN, replacement]);
    assert.deepEqual(await callHyperagentTool('get_thread', {}, h.deps), {
      ok: false, status: 401, data: null, error: 'HTTP 401',
    });
    assert.equal(h.requests.length, 1);
  });
}

test('missing initial token returns unconfigured without network access', async () => {
  const h = harness([], [null]);
  assert.deepEqual(await callHyperagentTool('get_thread', {}, h.deps), {
    ok: false, status: 0, data: null, error: 'unconfigured',
  });
  assert.equal(h.requests.length, 0);
});

test('successful SSE responses retain structured MCP result parsing', async () => {
  const h = harness([{ status: 200, body: `event: message\ndata: ${successBody}\n\n` }]);
  assert.deepEqual(await callHyperagentTool('list_threads', {}, h.deps), {
    ok: true, status: 200, data: { id: 'synthetic-result' },
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.tokenRequests.length, 1);
});
