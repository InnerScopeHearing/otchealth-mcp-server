/**
 * End-to-end tests for the AWS MCP bridge (tools.ts over upstream.ts, signed-fetch.ts and
 * credentials.ts) against a fake AWS MCP Server and a fake STS. There are no live AWS calls: every
 * network hop is a mocked fetch, and every credential is synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track',
  CIO_APP_API_BEARER: 'synthetic-app',
  PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'a'.repeat(32),
  N8N_WEBHOOK_SECRET: 'n'.repeat(32),
  READ_ONLY_MODE: 'true',
  ENABLE_WRITE_TOOLS: 'false',
  ENABLE_HIGH_RISK_TOOLS: 'false',
  DRY_RUN_DEFAULT: 'true',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  COLD_START_MODE: 'off',
  SHIELD_MODE: 'off',
  GROUNDEDNESS_MODE: 'off',
  AUTO_JOURNAL_MODE: 'off',
});
delete process.env.AWS_AI_READER_ROLE_ARN;
delete process.env.AWS_MCP_SIGNING_SERVICE;

const { requestContext } = await import('../../server/request-context.js');
const { requiredRoleFor } = await import('../../catalog/governance.js');
const { AWS_AI_ACCESS_SETUP_SCRIPT, AWS_AI_READER_ROLE_NAME, AwsReaderUnavailableError, createReaderCredentialProvider } = await import('./credentials.js');
const { AWS_MCP_ENDPOINT, AWS_MCP_MAX_UPSTREAM_BODY_BYTES } = await import('./signed-fetch.js');
const { AWS_MCP_MAX_OUTPUT_BYTES, jsonEscapedBytes } = await import('./output.js');
const { AwsMcpBridgeError, Semaphore } = await import('./upstream.js');
const bridge = await import('./tools.js');
type FetchLike = import('./signed-fetch.js').FetchLike;
type AwsMcpDeps = import('./tools.js').AwsMcpDeps;

// ---------------------------------------------------------------------------------------------
// Synthetic fixtures. Key-shaped literals are assembled so no source line looks like a credential.
// ---------------------------------------------------------------------------------------------
const ACCOUNT = '111122223333';
const BASE = {
  accessKeyId: 'ASIA' + 'SYNTHETICBASE001',
  secretAccessKey: 'synthetic-base-secret-not-real',
  sessionToken: 'synthetic-base-session-token',
};
const T0 = Date.parse('2026-10-08T00:00:00Z');
const HOUR = 3_600_000;
const CTO = { callerAgent: 'cto', correlationId: 'corr-1234-abcd-5678-efgh' };
const readerKey = (n: number): string => 'ASIA' + 'SYNTHETICRD' + String(n).padStart(5, '0');
const readerToken = (n: number): string => `synthetic-reader-session-token-${n}`;

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
}

function stsError(code: string): Response {
  return xml(
    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>SYNTHETIC-PRIVATE-DETAIL</Message></Error></ErrorResponse>`,
    403,
  );
}

/** A fake STS: GetCallerIdentity and AssumeRole, recording every request. */
function fakeSts(now: () => number, assumeFailure?: () => Response | Error | undefined) {
  const calls: Array<{ action: string; params: URLSearchParams }> = [];
  let assumed = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    const action = params.get('Action') ?? '';
    calls.push({ action, params });
    if (action === 'GetCallerIdentity') {
      return xml(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    }
    if (action === 'AssumeRole') {
      const failure = assumeFailure?.();
      if (failure instanceof Error) throw failure;
      if (failure) return failure;
      assumed += 1;
      return xml(
        `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${readerKey(assumed)}</AccessKeyId>` +
          `<SecretAccessKey>synthetic-reader-secret-${assumed}</SecretAccessKey><SessionToken>${readerToken(assumed)}</SessionToken>` +
          `<Expiration>${new Date(now() + HOUR).toISOString()}</Expiration></Credentials><AssumedRoleUser>` +
          `<Arn>arn:aws:sts::${ACCOUNT}:assumed-role/${AWS_AI_READER_ROLE_NAME}/gw-cto-x</Arn></AssumedRoleUser></AssumeRoleResult></AssumeRoleResponse>`,
      );
    }
    throw new Error(`unexpected STS action ${action}`);
  };
  return { fetchImpl, calls, assumeCount: () => assumed };
}

// ---------------------------------------------------------------------------------------------
// A fake AWS MCP Server (Streamable HTTP, JSON or SSE replies) over a mocked fetch.
// ---------------------------------------------------------------------------------------------
interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}
interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  rpc: RpcMessage | undefined;
}
type ToolReply =
  | { content?: unknown[]; isError?: boolean; structuredContent?: unknown }
  | { rpcError: { code: number; message: string } };
type Override = Response | Error | 'hang' | undefined;

interface McpBehavior {
  mode?: 'json' | 'sse';
  pages?: Array<Array<Record<string, unknown>>>;
  onCall?: (call: { name: string; args: Record<string, unknown>; meta: Record<string, unknown> | undefined }) => ToolReply | Promise<ToolReply>;
  /** Intercept any request before the default handling (HTTP failures, hangs, network errors). */
  onRequest?: (rpc: RpcMessage | undefined, method: string) => Override | Promise<Override>;
  deleteStatus?: number;
  callDelayMs?: number;
}

function rpcReply(mode: 'json' | 'sse', message: unknown, headers: Record<string, string> = {}): Response {
  if (mode === 'sse') {
    return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', ...headers },
    });
  }
  return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** AbortSignal.timeout() timers are unref'd, so a test that waits on one must hold the event loop open. */
function holdEventLoop(): () => void {
  const timer = setTimeout(() => undefined, 20_000);
  return () => clearTimeout(timer);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeAwsMcp(behavior: McpBehavior = {}) {
  const requests: Recorded[] = [];
  const mode = behavior.mode ?? 'json';
  let sessionCounter = 0;
  let activeCalls = 0;
  let maxActiveCalls = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    const method = String(init?.method ?? 'GET');
    const headers = { ...(init?.headers as Record<string, string>) };
    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    const rpc = bodyText === undefined ? undefined : (JSON.parse(bodyText) as RpcMessage);
    requests.push({ method, url: String(url), headers, rpc });

    const override = await behavior.onRequest?.(rpc, method);
    if (override === 'hang') return hangUntilAborted(init);
    if (override instanceof Error) throw override;
    if (override) return override;

    if (method === 'DELETE') return new Response(null, { status: behavior.deleteStatus ?? 200 });
    if (method !== 'POST' || !rpc) return new Response(null, { status: 405 });

    const result = (value: unknown, extra: Record<string, string> = {}): Response =>
      rpcReply(mode, { jsonrpc: '2.0', id: rpc.id, result: value }, extra);

    switch (rpc.method) {
      case 'initialize':
        sessionCounter += 1;
        return result(
          {
            protocolVersion: (rpc.params as { protocolVersion: string }).protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-aws-mcp', version: '0.0.0' },
          },
          { 'mcp-session-id': `sess-${sessionCounter}` },
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list': {
        const pages = behavior.pages ?? [[]];
        const cursor = (rpc.params as { cursor?: string } | undefined)?.cursor;
        const index = cursor ? Number(cursor.replace('page-', '')) : 0;
        return result({ tools: pages[index] ?? [], ...(index + 1 < pages.length ? { nextCursor: `page-${index + 1}` } : {}) });
      }
      case 'tools/call': {
        const params = rpc.params as { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        try {
          if (behavior.callDelayMs) await sleep(behavior.callDelayMs);
          const reply = await (behavior.onCall ?? (() => ({ content: [{ type: 'text', text: 'ok' }] })))({
            name: params.name,
            args: params.arguments ?? {},
            meta: params._meta,
          });
          if ('rpcError' in reply) return rpcReply(mode, { jsonrpc: '2.0', id: rpc.id, error: reply.rpcError });
          return result(reply);
        } finally {
          activeCalls -= 1;
        }
      }
      default:
        return rpcReply(mode, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `Method not found: ${rpc.method ?? ''}` } });
    }
  };

  return {
    fetchImpl,
    requests,
    maxActiveCalls: () => maxActiveCalls,
    sequence: () => requests.map((r) => (r.method === 'POST' ? `POST ${r.rpc?.method ?? '?'}` : r.method)),
    callRequests: () => requests.filter((r) => r.rpc?.method === 'tools/call'),
  };
}

// ---------------------------------------------------------------------------------------------
// A "world": fake STS + fake AWS MCP Server + the real credential provider, wired through deps.
// ---------------------------------------------------------------------------------------------
function world(opts: { mcp?: McpBehavior; assumeFailure?: () => Response | Error | undefined; deps?: Partial<AwsMcpDeps> } = {}) {
  let clock = T0;
  const sts = fakeSts(() => clock, opts.assumeFailure);
  const mcp = fakeAwsMcp(opts.mcp);
  const provider = createReaderCredentialProvider({ baseCredentials: async () => BASE, fetchImpl: sts.fetchImpl, now: () => clock });
  let credentialRequests = 0;
  const deps: AwsMcpDeps = {
    getCredentials: (hint: string) => {
      credentialRequests += 1;
      return provider.get(hint);
    },
    fetchImpl: mcp.fetchImpl,
    now: () => new Date(clock),
    ...opts.deps,
  };
  return { sts, mcp, provider, deps, credentialRequests: () => credentialRequests, advance: (ms: number) => { clock += ms; } };
}

function assertSignedAsReader(requests: Recorded[], key: string, token: string): void {
  assert.ok(requests.length > 0);
  for (const r of requests) {
    assert.equal(r.url, AWS_MCP_ENDPOINT);
    assert.match(
      r.headers.Authorization,
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${key}/\\d{8}/us-east-1/aws-mcp/aws4_request, SignedHeaders=[a-z;-]*x-amz-date[a-z;-]*, Signature=[0-9a-f]{64}$`),
    );
    assert.equal(r.headers['x-amz-security-token'], token);
    assert.equal(r.headers.host, 'aws-mcp.us-east-1.api.aws');
    assert.match(r.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
    assert.equal(r.headers['user-agent'], 'otchealth-mcp-gateway/aws-mcp-bridge');
    const flat = JSON.stringify(r.headers);
    assert.equal(flat.includes(BASE.sessionToken), false, 'the gateway task-role token never reaches the AWS MCP Server');
    assert.equal(flat.includes(BASE.accessKeyId), false, 'the gateway task-role key id never reaches the AWS MCP Server');
  }
}

const TOOL_ENTRIES = [
  { name: 'aws___run_script', description: 'Run a Python script.', inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } },
  { name: 'aws___search_documentation', description: 'Search AWS docs.', inputSchema: { type: 'object', properties: { search_phrase: { type: 'string' } } } },
  { name: 'aws___get_presigned_url', description: 'Mint a pre-signed URL.', inputSchema: { type: 'object', properties: {} } },
  { name: 'aws___brand_new_tool', description: 'Not reviewed yet.', inputSchema: { type: 'object', properties: {} } },
];

// ---------------------------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------------------------
test('Semaphore admits up to its limit, queues the rest in order and releases idempotently', async () => {
  const sem = new Semaphore(2);
  const a = await sem.acquire(100);
  const b = await sem.acquire(100);
  const order: string[] = [];
  const c = sem.acquire(1_000).then((release) => { order.push('c'); return release; });
  const d = sem.acquire(1_000).then((release) => { order.push('d'); return release; });
  await sleep(10);
  assert.deepEqual(order, [], 'both are still waiting');
  a();
  a(); // a second release of the same slot must not free another one
  const releaseC = await c;
  assert.deepEqual(order, ['c']);
  await sleep(10);
  assert.deepEqual(order, ['c'], 'only one slot was freed');
  b();
  const releaseD = await d;
  assert.deepEqual(order, ['c', 'd']);
  releaseC();
  releaseD();
});

test('Semaphore refuses with aws_mcp_busy after a bounded wait and leaves the queue clean', async () => {
  const sem = new Semaphore(1);
  const held = await sem.acquire(100);
  await assert.rejects(sem.acquire(30), (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_busy');
  held();
  const next = await sem.acquire(100);
  next();
});

// ---------------------------------------------------------------------------------------------
// Lane gate and input policy: all refused before any credential or network use
// ---------------------------------------------------------------------------------------------
test('LANE GATE: every non-CTO caller is refused by both tools before STS or the AWS MCP Server is touched', async () => {
  for (const callerAgent of ['developer', 'cfo', 'clo', 'clo-personal', 'coo', 'cro', 'cpo', 'cco', 'exec', 'external-read', 'wefunder', '', 'CTO', 'cto ']) {
    const w = world();
    const ctx = { callerAgent, correlationId: CTO.correlationId };
    await assert.rejects(bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, ctx, w.deps), /aws_mcp_forbidden/, `call as "${callerAgent}"`);
    await assert.rejects(bridge.listAwsMcpTools({}, ctx, w.deps), /aws_mcp_forbidden/, `list as "${callerAgent}"`);
    assert.equal(w.credentialRequests(), 0, `credentials requested for "${callerAgent}"`);
    assert.equal(w.sts.calls.length, 0);
    assert.equal(w.mcp.requests.length, 0);
  }
});

test('LANE GATE: the in-handler check comes first, so a non-CTO caller learns nothing from input validation either', async () => {
  const w = world();
  const ctx = { callerAgent: 'cfo', correlationId: CTO.correlationId };
  for (const input of [{ tool_name: 'aws___get_presigned_url' }, { tool_name: 'not a tool!!' }, null, { bogus: true }]) {
    await assert.rejects(bridge.callAwsMcpTool(input, ctx, w.deps), /aws_mcp_forbidden/);
  }
});

test('GOVERNANCE: the execution rule makes both tools CTO-only', () => {
  for (const name of [bridge.AWS_MCP_TOOL_LIST_NAME, bridge.AWS_MCP_TOOL_CALL_NAME]) {
    const rule = requiredRoleFor(name);
    assert.ok(rule, `${name} has a governance rule`);
    assert.equal(rule.role, 'cto');
  }
});

test('aws___get_presigned_url is blocked even for the CTO lane, with no credentials or network use', async () => {
  const w = world();
  await assert.rejects(
    bridge.callAwsMcpTool({ tool_name: 'aws___get_presigned_url', arguments: { bucket: 'b', key: 'k' } }, CTO, w.deps),
    /aws_mcp_tool_blocked: aws___get_presigned_url is blocked/,
  );
  assert.equal(w.credentialRequests(), 0);
  assert.equal(w.mcp.requests.length, 0);
  assert.equal(bridge.bridgeStatusOf('aws___get_presigned_url'), 'blocked');
});

test('only allowlisted upstream tools can be called', async () => {
  const w = world();
  for (const name of ['aws___brand_new_tool', 'aws___run_script2', 'run_script', 'AWS___RUN_SCRIPT']) {
    await assert.rejects(bridge.callAwsMcpTool({ tool_name: name }, CTO, w.deps), /aws_mcp_tool_not_allowed/, name);
  }
  assert.equal(w.mcp.requests.length, 0);
  assert.deepEqual(
    [...bridge.AWS_MCP_ALLOWED_UPSTREAM_TOOLS].sort(),
    ['aws___get_regional_availability', 'aws___get_tasks', 'aws___list_regions', 'aws___read_documentation', 'aws___retrieve_skill', 'aws___run_script', 'aws___search_documentation'],
  );
  assert.equal(bridge.AWS_MCP_ALLOWED_UPSTREAM_TOOLS.includes('aws___get_presigned_url'), false);
});

test('malformed input is rejected before any credential use', async () => {
  const w = world();
  const bad: unknown[] = [
    null,
    undefined,
    'aws___list_regions',
    {},
    { tool_name: '' },
    { tool_name: 'has space' },
    { tool_name: 'a'.repeat(101) },
    { tool_name: 'aws___list_regions', extra: 1 },
    { tool_name: 'aws___list_regions', arguments: 'not an object' },
    { tool_name: 'aws___list_regions', region: 'US_EAST_1' },
    { tool_name: 'aws___list_regions', region: 'us-east-1; drop' },
    { tool_name: 'aws___run_script', arguments: { script: 'x'.repeat(100_001) } },
  ];
  for (const input of bad) {
    await assert.rejects(bridge.callAwsMcpTool(input, CTO, w.deps), /aws_mcp_invalid_input/, JSON.stringify(input)?.slice(0, 80));
  }
  await assert.rejects(bridge.listAwsMcpTools({ unexpected: true }, CTO, w.deps), /aws_mcp_invalid_input/);
  assert.equal(w.credentialRequests(), 0);
  assert.equal(w.mcp.requests.length, 0);
});

// ---------------------------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------------------------
test('FAIL CLOSED: when the reader role cannot be assumed, no request reaches the AWS MCP Server and the CTO is told what the owner must run', async () => {
  const w = world({ assumeFailure: () => stsError('AccessDenied') });
  for (const run of [
    () => bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, w.deps),
    () => bridge.listAwsMcpTools({}, CTO, w.deps),
  ]) {
    await assert.rejects(run(), (err: unknown) => {
      assert.ok(err instanceof AwsReaderUnavailableError);
      assert.match(err.message, /^aws_mcp_unavailable \(assume_role_failed, STS AccessDenied\)/);
      assert.ok(err.message.includes(AWS_AI_ACCESS_SETUP_SCRIPT));
      assert.ok(err.message.includes('AWS CloudShell'));
      assert.equal(err.message.includes('SYNTHETIC-PRIVATE-DETAIL'), false);
      assert.equal(err.message.includes(ACCOUNT), false);
      return true;
    });
  }
  assert.equal(w.mcp.requests.length, 0, 'zero requests were sent to the AWS MCP Server');
  assert.deepEqual([...new Set(w.sts.calls.map((c) => c.action))].sort(), ['AssumeRole', 'GetCallerIdentity']);
  assert.equal(w.sts.assumeCount(), 0);
});

test('FAIL CLOSED: an unreachable STS and a missing base identity also stop the call before any MCP request', async () => {
  const unreachable = world({ assumeFailure: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) });
  await assert.rejects(bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, unreachable.deps), (err: unknown) =>
    err instanceof AwsReaderUnavailableError && err.reason === 'sts_unreachable');
  assert.equal(unreachable.mcp.requests.length, 0);

  const noBase = createReaderCredentialProvider({ baseCredentials: async () => null, fetchImpl: async () => { throw new Error('must not be called'); } });
  const mcp = fakeAwsMcp();
  await assert.rejects(
    bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, { getCredentials: (hint) => noBase.get(hint), fetchImpl: mcp.fetchImpl }),
    (err: unknown) => err instanceof AwsReaderUnavailableError && err.reason === 'no_base_credentials',
  );
  assert.equal(mcp.requests.length, 0);
});

test('FAIL CLOSED: a credential failure in the middle of a session (rotation gone wrong) cannot send an unsigned request', async () => {
  let calls = 0;
  const mcp = fakeAwsMcp();
  const provider = createReaderCredentialProvider({
    baseCredentials: async () => BASE,
    fetchImpl: fakeSts(() => T0).fetchImpl,
    now: () => T0,
  });
  const deps: AwsMcpDeps = {
    fetchImpl: mcp.fetchImpl,
    now: () => new Date(T0),
    getCredentials: async (hint) => {
      calls += 1;
      if (calls > 2) throw new AwsReaderUnavailableError('assume_role_failed', 'AccessDenied');
      return provider.get(hint);
    },
  };
  await assert.rejects(bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, deps), AwsReaderUnavailableError);
  for (const r of mcp.requests) assert.match(r.headers.Authorization, /^AWS4-HMAC-SHA256 /, 'every request that left was signed');
});

test('an AWS MCP Server request is never sent with anything but reader-role credentials, and STS uses the base identity only', async () => {
  const w = world();
  await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, w.deps);
  assertSignedAsReader(w.mcp.requests, readerKey(1), readerToken(1));
  const assume = w.sts.calls.find((c) => c.action === 'AssumeRole');
  assert.equal(assume?.params.get('RoleArn'), `arn:aws:iam::${ACCOUNT}:role/${AWS_AI_READER_ROLE_NAME}`);
  assert.match(assume?.params.get('RoleSessionName') ?? '', /^gw-cto-corr1234abcd$/);
  assert.equal(assume?.params.get('DurationSeconds'), '3600');
});

// ---------------------------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------------------------
for (const mode of ['json', 'sse'] as const) {
  test(`aws_mcp_tool_call (${mode} replies): a full signed session, the right arguments, and a labelled result`, async () => {
    const w = world({
      mcp: {
        mode,
        onCall: ({ name, args }) => ({ content: [{ type: 'text', text: `regions for ${name}: ${JSON.stringify(args)}` }] }),
      },
    });
    const result = await bridge.callAwsMcpTool({ tool_name: 'aws___search_documentation', arguments: { search_phrase: 'iam roles' } }, CTO, w.deps);

    assert.deepEqual(w.mcp.sequence(), ['POST initialize', 'POST notifications/initialized', 'POST tools/call', 'DELETE']);
    assert.equal(w.mcp.requests.some((r) => r.method === 'GET'), false, 'no event stream is ever opened');
    assertSignedAsReader(w.mcp.requests, readerKey(1), readerToken(1));

    const [init, , call, del] = w.mcp.requests;
    assert.deepEqual((init.rpc?.params as { clientInfo: unknown }).clientInfo, { name: 'otchealth-gateway-aws-bridge', version: '1.0.0' });
    assert.equal(call.headers['mcp-session-id'], 'sess-1');
    assert.match(call.headers['mcp-protocol-version'], /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(del.headers['mcp-session-id'], 'sess-1');
    assert.deepEqual(call.rpc?.params, {
      name: 'aws___search_documentation',
      arguments: { search_phrase: 'iam roles' },
      _meta: { AWS_REGION: 'us-east-1' },
    });

    assert.equal(result.upstream_tool, 'aws___search_documentation');
    assert.equal(result.region, 'us-east-1');
    assert.equal(result.is_error, false);
    assert.equal(result.content_text, 'regions for aws___search_documentation: {"search_phrase":"iam roles"}');
    assert.equal(result.truncated, false);
    assert.equal(result.redactions, 0);
    assert.equal(result.omitted_non_text_blocks, 0);
    assert.match(result.notice, /UNTRUSTED EXTERNAL DATA/);
  });
}

test('the region argument becomes the default region for the upstream call', async () => {
  const w = world();
  const result = await bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'print(1)' }, region: 'us-west-2' }, CTO, w.deps);
  assert.equal(result.region, 'us-west-2');
  assert.deepEqual((w.mcp.callRequests()[0].rpc?.params as { _meta: unknown })._meta, { AWS_REGION: 'us-west-2' });
});

test('an upstream tool that reports an error is surfaced as is_error with its text', async () => {
  const w = world({ mcp: { onCall: () => ({ isError: true, content: [{ type: 'text', text: 'AccessDenied: not allowed to perform s3:GetObject' }] }) } });
  const result = await bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'x' } }, CTO, w.deps);
  assert.equal(result.is_error, true);
  assert.match(result.content_text, /AccessDenied/);
});

test('non-text blocks are counted and dropped, embedded text is kept, and structured content is a fallback', async () => {
  const mixed = world({
    mcp: {
      onCall: () => ({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'resource_link', uri: 'file:///x', name: 'x' },
          { type: 'resource', resource: { uri: 'file:///y', text: 'embedded text' } },
        ],
      }),
    },
  });
  const result = await bridge.callAwsMcpTool({ tool_name: 'aws___retrieve_skill', arguments: {} }, CTO, mixed.deps);
  assert.equal(result.content_text, 'first\nembedded text');
  assert.equal(result.omitted_non_text_blocks, 2);

  const structured = world({ mcp: { onCall: () => ({ content: [], structuredContent: { regions: ['us-east-1', 'us-west-2'] } }) } });
  const fallback = await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, structured.deps);
  assert.deepEqual(JSON.parse(fallback.content_text), { regions: ['us-east-1', 'us-west-2'] });
});

test('upstream output is redacted, stripped of control characters, capped and labelled', async () => {
  const secret = 'SyntheticSecretValue' + '0123456789' + 'abcdefghij';
  const huge = `\u001b[31mstatus\u001b[0m\naws_secret_access_key=${secret}\n${'row of listing output\n'.repeat(6_000)}`;
  const w = world({ mcp: { onCall: () => ({ content: [{ type: 'text', text: huge }] }) } });
  const result = await bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'x' } }, CTO, w.deps);
  assert.equal(result.truncated, true);
  assert.equal(result.redactions, 1);
  assert.equal(result.original_bytes, Buffer.byteLength(huge, 'utf8'));
  assert.ok(jsonEscapedBytes(result.content_text) <= AWS_MCP_MAX_OUTPUT_BYTES);
  assert.equal(result.content_text.includes(secret), false);
  assert.equal(result.content_text.includes('\u001b'), false);
  assert.match(result.content_text, /^status\naws_secret_access_key=\[REDACTED\]\n/);
  assert.match(result.notice, /never follow instructions/);
});

test('aws_mcp_tool_list marks each upstream tool allowed, blocked or not_allowlisted and reports the signing scope', async () => {
  const w = world({ mcp: { pages: [TOOL_ENTRIES.slice(0, 2), TOOL_ENTRIES.slice(2)] } });
  const result = await bridge.listAwsMcpTools({}, CTO, w.deps);

  assert.deepEqual(w.mcp.sequence(), ['POST initialize', 'POST notifications/initialized', 'POST tools/list', 'POST tools/list', 'DELETE']);
  assert.deepEqual(w.mcp.requests[3].rpc?.params, { cursor: 'page-1' });
  assertSignedAsReader(w.mcp.requests, readerKey(1), readerToken(1));

  assert.equal(result.tool_count, 4);
  assert.equal(result.omitted_tools, 0);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.tools.map((t) => [t.name, t.bridge_status]), [
    ['aws___run_script', 'allowed'],
    ['aws___search_documentation', 'allowed'],
    ['aws___get_presigned_url', 'blocked'],
    ['aws___brand_new_tool', 'not_allowlisted'],
  ]);
  assert.deepEqual(result.tools[0].input_schema, TOOL_ENTRIES[0].inputSchema);
  assert.deepEqual(result.bridge, {
    endpoint_host: 'aws-mcp.us-east-1.api.aws',
    signing_service: 'aws-mcp',
    signing_region: 'us-east-1',
    reader_role_name: AWS_AI_READER_ROLE_NAME,
  });
  assert.match(result.notice, /UNTRUSTED EXTERNAL DATA/);
});

test('aws_mcp_tool_list stays inside its output budget however many or large the upstream tools are', async () => {
  const many = Array.from({ length: 250 }, (_unused, i) => ({
    name: `aws___tool_${i}`,
    description: 'd'.repeat(5_000),
    inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_u, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(100) }])) },
  }));
  const w = world({ mcp: { pages: [many.slice(0, 100), many.slice(100, 200), many.slice(200)] } });
  const result = await bridge.listAwsMcpTools({}, CTO, w.deps);
  assert.equal(result.tool_count, 250);
  assert.equal(result.truncated, true);
  assert.ok(result.tools.length <= 200, 'entries are capped');
  assert.equal(result.tools.length + result.omitted_tools, result.tool_count, 'every tool is either listed or counted as omitted');
  assert.ok(result.omitted_tools >= 50);
  assert.ok(result.tools.some((t) => t.detail_omitted), 'detail is dropped before names are');
  assert.ok(Buffer.byteLength(JSON.stringify({ tools: result.tools }, null, 2), 'utf8') <= 26_000, 'the pretty-printed list stays inside its budget');
  result.tools.forEach((t, i) => assert.equal(t.name, `aws___tool_${i}`, 'order is preserved'));
});

test('aws_mcp_tool_list keeps full detail for the early tools when the later ones do not fit', async () => {
  const big = Array.from({ length: 12 }, (_unused, i) => ({
    name: `aws___big_${i}`,
    description: 'd'.repeat(1_000),
    inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 12 }, (_u, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(100) }])) },
  }));
  const w = world({ mcp: { pages: [big] } });
  const result = await bridge.listAwsMcpTools({}, CTO, w.deps);
  assert.equal(result.tools.length, 12, 'every name is listed');
  assert.equal(result.truncated, true);
  assert.ok(result.tools[0].input_schema !== undefined && !result.tools[0].detail_omitted, 'the first tool keeps its schema');
  assert.ok(result.tools[11].detail_omitted === true, 'the last tool is reduced to its name');
  assert.ok(Buffer.byteLength(JSON.stringify({ tools: result.tools }, null, 2), 'utf8') <= 26_000);
});

// ---------------------------------------------------------------------------------------------
// Credential cache across calls
// ---------------------------------------------------------------------------------------------
test('credentials are reused across calls, then refreshed five minutes before expiry, and later calls use the new identity', async () => {
  const w = world();
  await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, w.deps);
  await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, { ...CTO, correlationId: 'corr-second-call-0002' }, w.deps);
  assert.equal(w.sts.assumeCount(), 1, 'the second call reused the cached role session');
  assertSignedAsReader(w.mcp.requests, readerKey(1), readerToken(1));

  w.advance(HOUR - 4 * 60_000); // inside the five-minute refresh margin
  const before = w.mcp.requests.length;
  await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, { ...CTO, correlationId: 'corr-third-call-00003' }, w.deps);
  assert.equal(w.sts.assumeCount(), 2, 'a fresh role session was assumed');
  assertSignedAsReader(w.mcp.requests.slice(before), readerKey(2), readerToken(2));
  assert.equal(w.sts.calls.filter((c) => c.action === 'GetCallerIdentity').length, 1);
});

// ---------------------------------------------------------------------------------------------
// Upstream failures: all become bounded, caller-safe errors
// ---------------------------------------------------------------------------------------------
const failures: Array<{ label: string; behavior: McpBehavior; code: string; message: RegExp }> = [
  {
    label: 'HTTP 403 with an AWS error body (and a credential-shaped string inside it)',
    behavior: {
      onRequest: (rpc) =>
        rpc?.method === 'initialize'
          ? new Response(JSON.stringify({ __type: 'AccessDeniedException', message: 'not authorized aws_secret_access_key=SYNTHETICSECRETVALUE123456' }), { status: 403, headers: { 'content-type': 'application/json' } })
          : undefined,
    },
    code: 'aws_mcp_rejected',
    message: /\(HTTP 403\): AccessDeniedException: not authorized aws_secret_access_key=\[REDACTED\]\. This points at the reader role permissions/,
  },
  {
    label: 'HTTP 429',
    behavior: { onRequest: (rpc) => (rpc?.method === 'initialize' ? new Response('slow down', { status: 429 }) : undefined) },
    code: 'aws_mcp_throttled',
    message: /HTTP 429; the account limit is about 10 requests per second/,
  },
  {
    label: 'HTTP 500',
    behavior: { onRequest: (rpc) => (rpc?.method === 'initialize' ? new Response('internal failure', { status: 500 }) : undefined) },
    code: 'aws_mcp_upstream_http',
    message: /answered HTTP 500: internal failure/,
  },
  {
    label: 'an unexpected content type',
    behavior: { onRequest: (rpc) => (rpc?.method === 'initialize' ? new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) : undefined) },
    code: 'aws_mcp_upstream_http',
    message: /sent an unexpected response/,
  },
  {
    label: 'a network failure',
    behavior: { onRequest: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) },
    code: 'aws_mcp_network',
    message: /could not reach the AWS MCP Server \(ECONNRESET\)\./,
  },
  {
    label: 'a JSON-RPC error from tools/call',
    behavior: { onCall: () => ({ rpcError: { code: -32602, message: 'Invalid params for the tool' } }) },
    code: 'aws_mcp_upstream_error',
    message: /MCP error \(code -32602\)/,
  },
  {
    label: 'a request-timeout error (the SDK timer and the call deadline can fire together)',
    behavior: { onCall: () => ({ rpcError: { code: -32001, message: 'Request timed out' } }) },
    code: 'aws_mcp_timeout',
    message: /did not answer within the bridge time limit/,
  },
  {
    label: 'a closed connection',
    behavior: { onCall: () => ({ rpcError: { code: -32000, message: 'Connection closed' } }) },
    code: 'aws_mcp_network',
    message: /connection to the AWS MCP Server closed/,
  },
  {
    label: 'a body that is not a JSON-RPC message',
    behavior: { onRequest: (rpc) => (rpc?.method === 'tools/call' ? new Response('definitely not json', { status: 200, headers: { 'content-type': 'application/json' } }) : undefined) },
    code: 'aws_mcp_protocol',
    message: /session failed unexpectedly/,
  },
  {
    label: 'a response larger than the size cap',
    behavior: {
      onRequest: (rpc) =>
        rpc?.method === 'tools/call'
          ? new Response('x'.repeat(AWS_MCP_MAX_UPSTREAM_BODY_BYTES + 1024), { status: 200, headers: { 'content-type': 'application/json' } })
          : undefined,
    },
    code: 'aws_mcp_response_too_large',
    message: /exceeded the bridge size limit/,
  },
];

for (const failure of failures) {
  test(`upstream failure: ${failure.label} becomes ${failure.code}`, async () => {
    const w = world({ mcp: failure.behavior });
    await assert.rejects(bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'x' } }, CTO, w.deps), (err: unknown) => {
      assert.ok(err instanceof AwsMcpBridgeError, String(err));
      assert.equal(err.code, failure.code);
      assert.match(err.message, new RegExp(`^${failure.code}: `));
      assert.match(err.message, failure.message);
      assert.equal(err.message.includes('SYNTHETICSECRETVALUE'), false, 'no credential-shaped upstream text is echoed');
      assert.ok(err.message.length < 700, 'the message stays short');
      return true;
    });
  });
}

test('a hung AWS MCP Server ends the call at the deadline with aws_mcp_timeout', async () => {
  const release = holdEventLoop();
  try {
    const w = world({ mcp: { onRequest: (rpc) => (rpc?.method === 'tools/call' ? 'hang' : undefined) }, deps: { deadlineMs: 300 } });
    const started = Date.now();
    await assert.rejects(
      bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'while True: pass' } }, CTO, w.deps),
      (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_timeout',
    );
    assert.ok(Date.now() - started < 5_000, 'the deadline, not the default, applied');
  } finally {
    release();
  }
});

test('a server that never answers initialize also times out, and the tool list path times out the same way', async () => {
  const release = holdEventLoop();
  try {
    const w = world({ mcp: { onRequest: (rpc) => (rpc?.method === 'initialize' ? 'hang' : undefined) }, deps: { deadlineMs: 250 } });
    await assert.rejects(bridge.listAwsMcpTools({}, CTO, w.deps), (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_timeout');
  } finally {
    release();
  }
});

test('a session-termination refusal (405) does not fail the call', async () => {
  const w = world({ mcp: { deleteStatus: 405 } });
  const result = await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, w.deps);
  assert.equal(result.is_error, false);
  assert.equal(w.mcp.sequence().at(-1), 'DELETE');
});

test('a failing session termination does not fail the call either', async () => {
  const w = world({ mcp: { onRequest: (_rpc, method) => (method === 'DELETE' ? new Response('boom', { status: 500 }) : undefined) } });
  const result = await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, w.deps);
  assert.equal(result.content_text, 'ok');
});

// ---------------------------------------------------------------------------------------------
// Concurrency limiting
// ---------------------------------------------------------------------------------------------
test('calls beyond the concurrent-session limit queue instead of running in parallel', async () => {
  const limiter = new Semaphore(1);
  const w = world({ mcp: { callDelayMs: 40 }, deps: { limiter } });
  const runs = ['a', 'b', 'c'].map((id) => bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, { ...CTO, correlationId: `corr-${id}-concurrency` }, w.deps));
  const results = await Promise.all(runs);
  assert.equal(results.length, 3);
  assert.equal(w.mcp.maxActiveCalls(), 1, 'never more than one upstream session at a time');
  assert.equal(w.sts.assumeCount(), 1, 'the three calls shared one role session');
});

test('when every slot stays busy past the queue wait the caller gets aws_mcp_busy, before any credential or network use', async () => {
  const limiter = new Semaphore(1);
  const held = await limiter.acquire(100);
  const w = world({ deps: { limiter, deadlineMs: 120 } });
  await assert.rejects(
    bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, w.deps),
    (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_busy',
  );
  assert.equal(w.credentialRequests(), 0);
  assert.equal(w.mcp.requests.length, 0);
  held();
});

test('a slot is released after a failed call', async () => {
  const limiter = new Semaphore(1);
  const failing = world({ mcp: { onRequest: () => new Response('nope', { status: 500 }) }, deps: { limiter } });
  await assert.rejects(bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, failing.deps), AwsMcpBridgeError);
  const ok = world({ deps: { limiter } });
  await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, ok.deps);
});

// ---------------------------------------------------------------------------------------------
// Through the real registerTool wrapper
// ---------------------------------------------------------------------------------------------
interface WrapperResponse {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  structuredContent?: { result?: Record<string, unknown> | null; error?: { code: string; message: string } };
}
interface CapturedTool {
  config: { annotations?: Record<string, unknown>; description?: string };
  handler: (args: unknown) => Promise<WrapperResponse>;
}

function fakeServer(): { server: McpServer; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  return {
    server: {
      registerTool(name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) {
        tools.set(name, { config, handler });
        return { remove: () => tools.delete(name) };
      },
    } as unknown as McpServer,
    tools,
  };
}

function invoke(tool: CapturedTool, args: Record<string, unknown>, callerAgent: string): Promise<WrapperResponse> {
  return requestContext.run({ callerHash: 'synthetic-hash', correlationId: 'corr-wrapper-0001', callerAgent }, () => tool.handler(args));
}

test('registration: both tools are registered read-only with an honest description', () => {
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', world().deps);
  assert.deepEqual([...tools.keys()].sort(), ['aws_mcp_tool_call', 'aws_mcp_tool_list']);
  for (const tool of tools.values()) {
    assert.equal(tool.config.annotations?.readOnlyHint, true);
    assert.equal(tool.config.annotations?.destructiveHint, false);
    assert.match(String(tool.config.description), /CTO lane only/);
    assert.match(String(tool.config.description), /untrusted external data/i);
  }
  assert.match(String(tools.get('aws_mcp_tool_call')?.config.description), /aws___get_presigned_url is blocked/);
});

test('wrapper: the CTO lane gets a result, including under READ_ONLY_MODE (this is a read tool)', async () => {
  const w = world({ mcp: { onCall: () => ({ content: [{ type: 'text', text: 'us-east-1 us-east-2' }] }) } });
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  const response = await invoke(tools.get('aws_mcp_tool_call')!, { tool_name: 'aws___list_regions' }, 'cto');
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent?.result?.content_text, 'us-east-1 us-east-2');
  assert.equal(response.structuredContent?.result?.is_error, false);
  assert.match(response.content?.[0].text ?? '', /UNTRUSTED EXTERNAL DATA/);
});

test('wrapper: a non-CTO caller is stopped by the execution governance rule before the handler runs', async () => {
  const w = world();
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  for (const callerAgent of ['developer', 'cfo', 'coo', 'cro', 'clo', 'exec', '']) {
    for (const [name, args] of [['aws_mcp_tool_call', { tool_name: 'aws___list_regions' }], ['aws_mcp_tool_list', {}]] as const) {
      const response = await invoke(tools.get(name)!, { ...args }, callerAgent);
      assert.equal(response.isError, true, `${name} as "${callerAgent}"`);
      assert.equal(response.structuredContent?.error?.code, 'forbidden_role');
    }
  }
  assert.equal(w.credentialRequests(), 0);
  assert.equal(w.mcp.requests.length, 0);
});

test('wrapper: the presigned-URL tool is blocked for the CTO lane with a clear error', async () => {
  const w = world();
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  const response = await invoke(tools.get('aws_mcp_tool_call')!, { tool_name: 'aws___get_presigned_url' }, 'cto');
  assert.equal(response.isError, true);
  assert.match(response.content?.[0].text ?? '', /^Tool aws_mcp_tool_call failed: aws_mcp_tool_blocked: aws___get_presigned_url is blocked/);
  assert.equal(w.mcp.requests.length, 0);
});

test('wrapper: the fail-closed message reaches the CTO and names the owner script', async () => {
  const w = world({ assumeFailure: () => stsError('AccessDenied') });
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  for (const [name, args] of [['aws_mcp_tool_call', { tool_name: 'aws___list_regions' }], ['aws_mcp_tool_list', {}]] as const) {
    const response = await invoke(tools.get(name)!, { ...args }, 'cto');
    assert.equal(response.isError, true);
    const text = response.content?.[0].text ?? '';
    assert.match(text, new RegExp(`^Tool ${name} failed: aws_mcp_unavailable \\(assume_role_failed, STS AccessDenied\\)`));
    assert.ok(text.includes(AWS_AI_ACCESS_SETUP_SCRIPT));
    assert.equal(text.includes('SYNTHETIC-PRIVATE-DETAIL'), false);
  }
  assert.equal(w.mcp.requests.length, 0);
});

test('wrapper: the strict input schema rejects unknown fields', async () => {
  const w = world();
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  const response = await invoke(tools.get('aws_mcp_tool_call')!, { tool_name: 'aws___list_regions', credentials: 'x' }, 'cto');
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent?.error?.code, 'invalid_input');
  assert.equal(w.mcp.requests.length, 0);
});

test('wrapper: worst-case output stays under the response cap and under the shared-cache offload threshold', async () => {
  // Quote-dense text is the worst case: every character is escaped once in the pretty-printed text
  // block and again when that block is embedded in the response envelope.
  const w = world({ mcp: { onCall: () => ({ content: [{ type: 'text', text: '"'.repeat(500_000) }] }) } });
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  const response = await invoke(tools.get('aws_mcp_tool_call')!, { tool_name: 'aws___run_script', arguments: { script: 'x' } }, 'cto');
  assert.equal(response.isError, undefined, response.content?.[0].text);
  assert.equal(response.structuredContent?.result?.truncated, true);
  assert.equal(response.structuredContent?.result?._jit_offloaded, undefined, 'AWS output is never offloaded into the shared cache');
  const envelope = Buffer.byteLength(JSON.stringify({ content: response.content, structuredContent: response.structuredContent }), 'utf8');
  assert.ok(envelope < 128 * 1024, `envelope ${envelope} bytes`);
  assert.ok((response.content?.[0].text.length ?? Infinity) < 40_000, 'below the default JIT offload threshold');
});

test('wrapper: a maximal tool list also stays under the response cap and the offload threshold', async () => {
  const many = Array.from({ length: 300 }, (_unused, i) => ({
    name: `aws___tool_${i}`,
    description: 'quote " heavy description '.repeat(200),
    inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 30 }, (_u, j) => [`p${j}`, { type: 'string', description: 'x"y'.repeat(40) }])) },
  }));
  const w = world({ mcp: { pages: [many.slice(0, 100), many.slice(100, 200), many.slice(200)] } });
  const { server, tools } = fakeServer();
  bridge.registerAwsMcpTools(server, () => 'synthetic-hash', w.deps);
  const response = await invoke(tools.get('aws_mcp_tool_list')!, {}, 'cto');
  assert.equal(response.isError, undefined, response.content?.[0].text);
  assert.equal(response.structuredContent?.result?._jit_offloaded, undefined);
  const envelope = Buffer.byteLength(JSON.stringify({ content: response.content, structuredContent: response.structuredContent }), 'utf8');
  assert.ok(envelope < 128 * 1024, `envelope ${envelope} bytes`);
  assert.ok((response.content?.[0].text.length ?? Infinity) < 40_000);
});
