import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { requestContext } from '../../server/request-context.js';
import { listOperations } from '../../intercom/operations-contract.js';
import { registerIntercomOperations } from './operations.js';

before(() => {
  const env: Record<string, string> = {
    CIO_SITE_ID: 'test', CIO_TRACK_KEY: 'test', CIO_APP_API_BEARER: 'test',
    PERPLEXITY_CONNECTOR_TOKEN: 'a'.repeat(32), ADMIN_REVOKE_TOKEN: 'b'.repeat(32),
    N8N_WEBHOOK_SECRET: 'c'.repeat(32), INTERCOM_ACCESS_TOKEN: 'test-intercom-token',
    INTERCOM_FIN_ACCESS_TOKEN: 'test-fin-token', DRY_RUN_DEFAULT: 'true',
    READ_ONLY_MODE: 'false', ENABLE_WRITE_TOOLS: 'true', ENABLE_HIGH_RISK_TOOLS: 'true',
    CONNECTOR_ANNOTATIONS_MODE: 'on', TOOL_CATALOG_CURATION_MODE: 'off',
  };
  for (const [key, value] of Object.entries(env)) process.env[key] ??= value;
});

interface Harness {
  call(name: string, args: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

async function boot(lane: string): Promise<Harness> {
  const context = { callerHash: `test-${lane}`, correlationId: `operations-${lane}`, callerAgent: lane };
  const server = new McpServer({ name: `intercom-operations-${lane}`, version: 'test' }, { capabilities: { tools: { listChanged: true } } });
  requestContext.run(context, () => registerIntercomOperations(server, () => context.callerHash));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `operations-client-${lane}`, version: 'test' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    call: (name, args) => requestContext.run(context, () => client.callTool({ name, arguments: args })),
    async close() { await client.close(); await server.close(); },
  };
}

function serial(result: unknown): string { return JSON.stringify(result); }

test('admin reads project connector results and conversation operations to bounded metadata', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ method: init?.method ?? 'GET', path: url.pathname });
    return new Response(JSON.stringify({
      data_connectors: [{ id: 'connector-1', name: 'Safe connector', status: 'active', http_method: 'get', direct_fin_usage: true, audiences: ['users'], data_inputs: [{ name: 'order_id', type: 'string', required: true, description: 'private detail' }], headers: [{ name: 'Authorization', value: 'Bearer secret' }], url: 'https://api.example.invalid?token=secret', api_token: 'do-not-return', config: { password: 'do-not-return' }, body: 'raw connector payload' }],
      pages: { type: 'next', next: { starting_after: 'cursor-2' } },
      result: { body: 'raw connector result' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const harness = await boot('coo');
  try {
    const result = await harness.call('intercom_operation_read', { operation_id: 'listDataConnectors' });
    assert.equal(result.isError, undefined, serial(result));
    const payload = serial(result.structuredContent);
    assert.match(payload, /Safe connector/);
    assert.match(payload, /direct_fin_usage/);
    assert.match(payload, /order_id/);
    assert.match(payload, /users/);
    assert.match(payload, /cursor-2/);
    assert.doesNotMatch(payload, /do-not-return|raw connector|private detail|Authorization|https:\/\/api\.example/);
    assert.deepEqual(requests, [{ method: 'GET', path: '/data_connectors' }]);
  } finally {
    await harness.close();
    globalThis.fetch = originalFetch;
  }
});

test('conversation search returns operational metadata only; assignment and status writes reject reply bodies', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ conversations: [{ id: 'conversation-1', name: 'private customer name', state: 'open', admin_assignee_id: 'admin-8', team_assignee_id: 'team-4', source: { body: 'private customer PHI', author: { email: 'customer@example.invalid' } }, contact_ids: ['contact-1'] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const harness = await boot('coo');
  try {
    const search = await harness.call('intercom_operation_read', { operation_id: 'searchConversations', body: { query: { field: 'state', operator: '=', value: 'open' } } });
    assert.equal(search.isError, undefined, serial(search));
    assert.match(serial(search.structuredContent), /conversation-1|admin-8/);
    assert.doesNotMatch(serial(search.structuredContent), /private customer name|private customer PHI|customer@example.invalid|contact-1/);

    const preview = await harness.call('intercom_operation_write', { operation_id: 'manageConversation', path_params: { conversation_id: 'conversation-1' }, body: { message_type: 'close', type: 'admin', admin_id: 'admin-8' } });
    assert.equal(preview.isError, undefined, serial(preview));
    assert.equal((preview.structuredContent as any)?.result?.executed, false);
    const reply = await harness.call('intercom_operation_write', { operation_id: 'manageConversation', path_params: { conversation_id: 'conversation-1' }, body: { message_type: 'close', type: 'admin', admin_id: 'admin-8', body: 'customer-facing reply' } });
    assert.equal(reply.isError, true);
    assert.equal(requests.length, 1, 'read search is the only provider request; status write is dry-run');
  } finally {
    await harness.close();
    globalThis.fetch = originalFetch;
  }
});

test('data connector writes allow token references and reject inline credentials', async () => {
  const harness = await boot('cto');
  try {
    const preview = await harness.call('intercom_operation_write', {
      operation_id: 'createDataConnector',
      body: { name: 'Order lookup', headers: [{ name: 'Authorization', value: 'Bearer {{existing_api_token}}' }], token_ids: ['auth_ref_1'] },
    });
    assert.equal(preview.isError, undefined, serial(preview));
    assert.equal((preview.structuredContent as any)?.result?.executed, false);
    const inline = await harness.call('intercom_operation_write', {
      operation_id: 'createDataConnector',
      body: { name: 'Order lookup', headers: [{ name: 'Authorization', value: 'Bearer live-secret-12345' }] },
    });
    assert.equal(inline.isError, true);
    assert.doesNotMatch(serial(inline), /live-secret-12345/);
  } finally { await harness.close(); }
});

test('reporting job results expose IDs, status, and links without signed query data or report rows', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    job_identifier: 'report-job-1', status: 'completed',
    download_url: 'https://reports.example.invalid/report.csv?X-Signature=private-signature',
    data: [{ contact_email: 'private@example.invalid', message: 'raw report row' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const harness = await boot('coo');
  try {
    const result = await harness.call('intercom_operation_read', { operation_id: 'get__export_reporting_data_job_identifier_', path_params: { job_identifier: 'report-job-1' }, query: { app_id: 'test-app', client_id: 'test-client' } });
    assert.equal(result.isError, undefined, serial(result));
    assert.match(serial(result.structuredContent), /report-job-1|completed|reports\.example\.invalid/);
    assert.doesNotMatch(serial(result.structuredContent), /private-signature|private@example|raw report row/);
  } finally {
    await harness.close();
    globalThis.fetch = originalFetch;
  }
});

test('writes default to dry-run, gate deletion acknowledgement, and project live responses', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ away_mode_enabled: true, admin_id: 44, name: 'Synthetic admin', api_token: 'hidden-token', body: 'private message' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const harness = await boot('cto');
  try {
    const request = { operation_id: 'setAwayAdmin', path_params: { admin_id: '44' }, body: { away_mode_enabled: true, away_mode_reassign: false } };
    const preview = await harness.call('intercom_operation_write', request);
    assert.equal(preview.isError, undefined, serial(preview));
    assert.equal((preview.structuredContent as any)?.result?.executed, false);
    assert.deepEqual(requests, []);

    const deleteWithoutAck = await harness.call('intercom_operation_write', { operation_id: 'deleteArticle', path_params: { article_id: '51' }, dry_run: false });
    assert.equal(deleteWithoutAck.isError, true);
    assert.deepEqual(requests, []);

    const applied = await harness.call('intercom_operation_write', { ...request, dry_run: false });
    assert.equal(applied.isError, undefined, serial(applied));
    assert.deepEqual(requests, [{ method: 'PUT', path: '/admins/44/away', body: request.body }]);
    assert.doesNotMatch(serial(applied.structuredContent), /hidden-token|private message/);
  } finally {
    await harness.close();
    globalThis.fetch = originalFetch;
  }
});

test('generic contact operations, unsafe conversation search, and non-owning roles are denied before provider access', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}'); };
  const coo = await boot('coo');
  try {
    const contact = await coo.call('intercom_operation_read', { operation_id: 'ShowContact', path_params: { contact_id: 'someone' } });
    assert.equal(contact.isError, true);
    const unsafeSearch = await coo.call('intercom_operation_read', {
      operation_id: 'searchConversations',
      body: { query: { field: 'source.body', operator: '=', value: 'private text' } },
    });
    assert.equal(unsafeSearch.isError, true);
    assert.equal(calls, 0);
  } finally { await coo.close(); }
  const external = await boot('external-readonly');
  try {
    const result = await external.call('intercom_operation_catalog', {});
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  } finally {
    await external.close();
    globalThis.fetch = originalFetch;
  }
});

test('catalog counts all fixed operations and advertises controlled configuration families', async () => {
  const harness = await boot('coo');
  try {
    const page = await harness.call('intercom_operation_catalog', { offset: 0, limit: 25 });
    assert.equal(page.isError, undefined, serial(page));
    const catalog = (page.structuredContent as any)?.result;
    assert.equal(catalog?.total, 251);
    assert.equal(catalog?.counts?.enabled + catalog?.counts?.held, catalog?.total);
    assert.equal(catalog?.coverage?.total, 258);
    assert.equal(catalog?.coverage?.enabled + catalog?.coverage?.held, 258);
    const all = [0, 100, 200].flatMap((offset) => listOperations({ domain: 'admin', offset, limit: 100 }));
    const index = all.findIndex((operation) => operation.operation_id === 'createDataConnector');
    const connectorPage = await harness.call('intercom_operation_catalog', { offset: Math.floor(index / 25) * 25, limit: 25 });
    const operations = (connectorPage.structuredContent as any)?.result?.operations ?? [];
    const createConnector = operations.find((operation: any) => operation.operation_id === 'createDataConnector');
    assert.equal(createConnector?.access, 'write');
    assert.equal(createConnector?.available, true);
  } finally { await harness.close(); }
});

test('Fin runtime is isolated, dry-run by default, and free-form Fin responses are never projected', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; authorization: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ method: init?.method ?? 'GET', path: url.pathname, authorization: new Headers(init?.headers).get('authorization') ?? '' });
    return new Response(JSON.stringify({ id: 'fin-1', status: 'ok', answer: 'private Fin response', body: 'private customer message', api_token: 'hidden-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const harness = await boot('coo');
  try {
    const catalog = await harness.call('intercom_fin_operation_catalog', { offset: 0, limit: 25 });
    const catalogData = (catalog.structuredContent as any)?.result;
    assert.equal(catalogData?.total, 7);
    assert.equal(catalogData?.counts?.enabled + catalogData?.counts?.held, 7);
    assert.ok(catalogData?.operations.every((operation: any) => operation.access === 'explicit_write_only'));
    assert.ok(catalogData?.operations.every((operation: any) => operation.gate === 'explicit_paid_runtime_write_requires_fin_invoke_dry_run_and_acknowledgement'));

    const schema = await harness.call('intercom_fin_operation_schema', { operation_id: 'askFin' });
    assert.equal(schema.isError, undefined, serial(schema));
    assert.match(serial(schema.structuredContent), /body/);
    assert.match(serial(schema.structuredContent), /components/);
    assert.doesNotMatch(serial(schema.structuredContent), /How can I see my account|John Doe|example/);
    const preview = await harness.call('intercom_fin_operation_invoke', { operation_id: 'listFinCapabilities', body: { user: { id: 'synthetic-user' } } });
    assert.equal(preview.isError, undefined, serial(preview));
    assert.equal(requests.length, 0);

    const unacknowledged = await harness.call('intercom_fin_operation_invoke', { operation_id: 'listFinCapabilities', body: { user: { id: 'synthetic-user' } }, dry_run: false });
    assert.equal(unacknowledged.isError, true);
    assert.equal(requests.length, 0);

    const live = await harness.call('intercom_fin_operation_invoke', { operation_id: 'listFinCapabilities', body: { user: { id: 'synthetic-user' } }, dry_run: false, acknowledge_warning: true });
    assert.equal(live.isError, undefined, serial(live));
    assert.deepEqual(requests, [{ method: 'POST', path: '/fin/capabilities', authorization: 'Bearer test-fin-token' }]);
    assert.doesNotMatch(serial(live.structuredContent), /private Fin response|private customer message|hidden-token/);
  } finally {
    await harness.close();
    globalThis.fetch = originalFetch;
  }
});
