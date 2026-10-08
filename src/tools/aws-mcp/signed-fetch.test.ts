import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  AWS_MCP_ENDPOINT,
  AWS_MCP_MAX_REQUEST_BODY_BYTES,
  AWS_MCP_MAX_UPSTREAM_BODY_BYTES,
  AWS_MCP_SIGNING_SERVICE_ENV,
  createSigningFetch,
  deriveSigningScope,
  resolveSigningScope,
  type FetchLike,
} from './signed-fetch.js';

// Synthetic values only; key-shaped literals are assembled so no source line looks like a credential.
const CREDS = {
  accessKeyId: 'ASIA' + 'SYNTHETICREAD01',
  secretAccessKey: 'synthetic-reader-secret-not-real',
  sessionToken: 'synthetic-reader-session-token',
};
const NOW = new Date('2026-10-08T12:00:00Z');
const AMZ_DATE = '20261008T120000Z';
const DATE_STAMP = '20261008';
const HOST = 'aws-mcp.us-east-1.api.aws';
const SCOPE = { service: 'aws-mcp', region: 'us-east-1' };

interface Sent {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function harness(overrides: { getCredentials?: () => Promise<typeof CREDS>; remainingMs?: () => number; onOversizedResponse?: () => void; reply?: (sent: Sent) => Response | Promise<Response> } = {}) {
  const sent: Sent[] = [];
  let credentialCalls = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const record = { url: String(url), init: init as Sent['init'] };
    sent.push(record);
    return overrides.reply ? overrides.reply(record) : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const signing = createSigningFetch({
    scope: SCOPE,
    getCredentials: async () => {
      credentialCalls += 1;
      return overrides.getCredentials ? overrides.getCredentials() : CREDS;
    },
    fetchImpl,
    now: () => NOW,
    remainingMs: overrides.remainingMs ?? (() => 30_000),
    onOversizedResponse: overrides.onOversizedResponse,
  });
  return { signing, sent, credentialCalls: () => credentialCalls };
}

/** AbortSignal.timeout() timers are unref'd, so a test that waits on one must hold the event loop open. */
function holdEventLoop(): () => void {
  const timer = setTimeout(() => undefined, 10_000);
  return () => clearTimeout(timer);
}

const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** SigV4 recomputed from the specification, independently of src/search/sigv4.ts. */
function expectedSignature(opts: { method: string; body: string; signedHeaders: string[]; headerValues: Record<string, string>; service: string; region: string }): string {
  const headerBlock = opts.signedHeaders.map((name) => `${name}:${opts.headerValues[name]}`).join('\n');
  const canonicalRequest = [opts.method, '/mcp', '', headerBlock, '', opts.signedHeaders.join(';'), sha256Hex(opts.body)].join('\n');
  const scope = `${DATE_STAMP}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', AMZ_DATE, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + CREDS.secretAccessKey, DATE_STAMP);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  return createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
}

test('deriveSigningScope follows mcp-proxy-for-aws: [service, region, api, aws] hosts', () => {
  assert.deepEqual(deriveSigningScope('aws-mcp.us-east-1.api.aws'), { service: 'aws-mcp', region: 'us-east-1' });
  assert.deepEqual(deriveSigningScope('aws-mcp.eu-west-1.api.aws'), { service: 'aws-mcp', region: 'eu-west-1' });
  for (const bad of ['', 'example.com', 'aws-mcp.us-east-1.amazonaws.com', 'a.b.c.api.aws', 'aws-mcp.us-east-1.api.aws.evil.test', '.us-east-1.api.aws']) {
    assert.throws(() => deriveSigningScope(bad), /aws_mcp_signing_scope_underivable/, bad);
  }
});

test('the bridge endpoint resolves to service aws-mcp in us-east-1, with an optional validated service override', () => {
  assert.equal(AWS_MCP_ENDPOINT, 'https://aws-mcp.us-east-1.api.aws/mcp');
  assert.deepEqual(resolveSigningScope({}), { service: 'aws-mcp', region: 'us-east-1' });
  assert.deepEqual(resolveSigningScope({ [AWS_MCP_SIGNING_SERVICE_ENV]: '   ' }), { service: 'aws-mcp', region: 'us-east-1' });
  assert.deepEqual(resolveSigningScope({ [AWS_MCP_SIGNING_SERVICE_ENV]: 'aws-mcp-alt' }), { service: 'aws-mcp-alt', region: 'us-east-1' });
  for (const bad of ['Bad Service', 'x', 'a/b', 'UPPER', 'a'.repeat(41)]) {
    assert.throws(() => resolveSigningScope({ [AWS_MCP_SIGNING_SERVICE_ENV]: bad }), /aws_mcp_signing_service_invalid/, bad);
  }
});

test('a POST is signed with SigV4 over the endpoint host, service aws-mcp and region us-east-1', async () => {
  const { signing, sent } = harness();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const res = await signing(AWS_MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);

  const { url, init } = sent[0];
  assert.equal(url, AWS_MCP_ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, body);
  assert.equal(init.redirect, 'error', 'a redirect must never carry the security token to another host');
  assert.ok(init.signal instanceof AbortSignal);

  const h = init.headers;
  assert.equal(h.host, HOST);
  assert.equal(h['x-amz-date'], AMZ_DATE);
  assert.equal(h['x-amz-security-token'], CREDS.sessionToken);
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h.accept, 'application/json, text/event-stream');
  assert.match(
    h.Authorization,
    new RegExp(
      `^AWS4-HMAC-SHA256 Credential=${CREDS.accessKeyId}/${DATE_STAMP}/us-east-1/aws-mcp/aws4_request, ` +
        'SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$',
    ),
  );
  for (const value of Object.values(h)) {
    assert.equal(value.includes(CREDS.secretAccessKey), false, 'the secret key never appears in a header');
  }
});

test('the signature matches an independent SigV4 computation over the real body', async () => {
  const { signing, sent } = harness();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aws___list_regions', arguments: {} } });
  await signing(AWS_MCP_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  const h = sent[0].init.headers;
  const signature = /Signature=([0-9a-f]{64})$/.exec(h.Authorization)?.[1];
  const expected = expectedSignature({
    method: 'POST',
    body,
    signedHeaders: ['content-type', 'host', 'x-amz-date', 'x-amz-security-token'],
    headerValues: { 'content-type': 'application/json', host: HOST, 'x-amz-date': AMZ_DATE, 'x-amz-security-token': CREDS.sessionToken },
    service: 'aws-mcp',
    region: 'us-east-1',
  });
  assert.equal(signature, expected);
});

test('the transport headers (accept, session id, protocol version) are signed too, matching an independent computation', async () => {
  const { signing, sent } = harness();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aws___list_regions', arguments: {} } });
  const accept = 'application/json, text/event-stream';
  await signing(AWS_MCP_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: accept, 'Mcp-Session-Id': 'sess-1', 'MCP-Protocol-Version': '2025-06-18' },
    body,
  });
  const h = sent[0].init.headers;
  const signedHeaders = ['accept', 'content-type', 'host', 'mcp-protocol-version', 'mcp-session-id', 'x-amz-date', 'x-amz-security-token'];
  assert.match(h.Authorization, new RegExp(`SignedHeaders=${signedHeaders.join(';')}, Signature=[0-9a-f]{64}$`));
  assert.equal(
    /Signature=([0-9a-f]{64})$/.exec(h.Authorization)?.[1],
    expectedSignature({
      method: 'POST',
      body,
      signedHeaders,
      headerValues: {
        accept,
        'content-type': 'application/json',
        host: HOST,
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-1',
        'x-amz-date': AMZ_DATE,
        'x-amz-security-token': CREDS.sessionToken,
      },
      service: 'aws-mcp',
      region: 'us-east-1',
    }),
  );
  assert.equal(/SignedHeaders=[^,]*user-agent/.test(h.Authorization), false, 'user-agent is added after signing, as botocore does');
  assert.equal(h['user-agent'], 'otchealth-mcp-gateway/aws-mcp-bridge');
});

test('a different body, service or region changes the signature', async () => {
  const sigOf = async (body: string, scope = SCOPE): Promise<string> => {
    const sent: Sent[] = [];
    const signing = createSigningFetch({
      scope,
      getCredentials: async () => CREDS,
      fetchImpl: async (url, init) => {
        sent.push({ url: String(url), init: init as Sent['init'] });
        return new Response('{}');
      },
      now: () => NOW,
      remainingMs: () => 5_000,
    });
    await signing(AWS_MCP_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return /Signature=([0-9a-f]{64})$/.exec(sent[0].init.headers.Authorization)?.[1] ?? '';
  };
  const base = await sigOf('{"a":1}');
  assert.notEqual(await sigOf('{"a":2}'), base);
  assert.notEqual(await sigOf('{"a":1}', { service: 'other-service', region: 'us-east-1' }), base);
  assert.notEqual(await sigOf('{"a":1}', { service: 'aws-mcp', region: 'us-west-2' }), base);
  assert.equal(await sigOf('{"a":1}'), base, 'signing is deterministic for a fixed clock');
});

test('content-type defaults to application/json and caller-supplied managed headers are replaced, not forwarded', async () => {
  const { signing, sent } = harness();
  await signing(AWS_MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: 'Bearer SYNTHETIC-CALLER-AUTH',
      'x-amz-security-token': 'SYNTHETIC-CALLER-TOKEN',
      'x-amz-date': '19700101T000000Z',
      'x-amz-content-sha256': 'SYNTHETIC-HASH',
      host: 'evil.example.invalid',
      'user-agent': 'caller-agent',
      'content-length': '999',
      connection: 'keep-alive',
      'mcp-session-id': 'session-1',
      'mcp-protocol-version': '2025-06-18',
    },
    body: '{}',
  });
  const h = sent[0].init.headers;
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h.host, HOST);
  assert.equal(h['x-amz-date'], AMZ_DATE);
  assert.equal(h['x-amz-security-token'], CREDS.sessionToken);
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(h['user-agent'], 'otchealth-mcp-gateway/aws-mcp-bridge');
  assert.equal(h['mcp-session-id'], 'session-1', 'session headers are forwarded');
  assert.equal(h['mcp-protocol-version'], '2025-06-18');
  for (const dropped of ['authorization', 'x-amz-content-sha256', 'content-length', 'connection']) {
    assert.equal(dropped in h, false, `${dropped} must not be forwarded`);
  }
  assert.match(h.Authorization, /SignedHeaders=content-type;host;mcp-protocol-version;mcp-session-id;x-amz-date;x-amz-security-token, /);
  assert.equal(JSON.stringify(h).includes('SYNTHETIC-CALLER'), false);
});

test('headers given as a Headers object or as tuples are understood', async () => {
  for (const headers of [
    new Headers({ 'Content-Type': 'application/json', 'Mcp-Session-Id': 'abc' }),
    [['Content-Type', 'application/json'], ['Mcp-Session-Id', 'abc']] as Array<[string, string]>,
  ]) {
    const { signing, sent } = harness();
    await signing(AWS_MCP_ENDPOINT, { method: 'POST', headers, body: '{}' });
    assert.equal(sent[0].init.headers['mcp-session-id'], 'abc');
    assert.equal(sent[0].init.headers['content-type'], 'application/json');
  }
});

test('a GET is answered locally with 405: no request, no credentials', async () => {
  const { signing, sent, credentialCalls } = harness();
  const res = await signing(AWS_MCP_ENDPOINT, { method: 'GET', headers: { accept: 'text/event-stream' } });
  assert.equal(res.status, 405);
  assert.equal(sent.length, 0);
  assert.equal(credentialCalls(), 0);
  const implicit = await signing(AWS_MCP_ENDPOINT);
  assert.equal(implicit.status, 405, 'no method means GET');
  assert.equal(sent.length, 0);
});

test('a DELETE (session termination) is signed without a body or content-type', async () => {
  const { signing, sent } = harness();
  await signing(AWS_MCP_ENDPOINT, { method: 'DELETE', headers: { 'mcp-session-id': 'abc', 'mcp-protocol-version': '2025-06-18' } });
  const { init } = sent[0];
  assert.equal(init.method, 'DELETE');
  assert.equal(init.body, undefined);
  assert.equal('content-type' in init.headers, false);
  assert.match(init.headers.Authorization, /SignedHeaders=host;mcp-protocol-version;mcp-session-id;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  const signature = /Signature=([0-9a-f]{64})$/.exec(init.headers.Authorization)?.[1];
  assert.equal(
    signature,
    expectedSignature({
      method: 'DELETE',
      body: '',
      signedHeaders: ['host', 'mcp-protocol-version', 'mcp-session-id', 'x-amz-date', 'x-amz-security-token'],
      headerValues: {
        host: HOST,
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'abc',
        'x-amz-date': AMZ_DATE,
        'x-amz-security-token': CREDS.sessionToken,
      },
      service: 'aws-mcp',
      region: 'us-east-1',
    }),
  );
});

test('only the one endpoint is ever contacted: other targets are refused before credentials or network', async () => {
  const targets = [
    'http://aws-mcp.us-east-1.api.aws/mcp',
    'https://evil.example.invalid/mcp',
    'https://aws-mcp.us-east-1.api.aws/other',
    'https://aws-mcp.us-east-1.api.aws/mcp/extra',
    'https://aws-mcp.us-east-1.api.aws/mcp?x=1',
    'https://aws-mcp.us-east-1.api.aws:8443/mcp',
    'https://user:pass@aws-mcp.us-east-1.api.aws/mcp',
    'https://aws-mcp.us-east-1.api.aws.evil.example.invalid/mcp',
  ];
  for (const target of targets) {
    const { signing, sent, credentialCalls } = harness();
    await assert.rejects(signing(target, { method: 'POST', body: '{}' }), /aws_mcp_signing_target_rejected/, target);
    assert.equal(sent.length, 0, target);
    assert.equal(credentialCalls(), 0, target);
  }
});

test('methods other than POST, DELETE (and the local GET answer) are refused', async () => {
  for (const method of ['PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
    const { signing, sent } = harness();
    await assert.rejects(signing(AWS_MCP_ENDPOINT, { method, body: '{}' }), /aws_mcp_signing_method_rejected/, method);
    assert.equal(sent.length, 0);
  }
});

test('a POST body must be a string within the request size cap', async () => {
  const { signing, sent } = harness();
  await assert.rejects(signing(AWS_MCP_ENDPOINT, { method: 'POST', body: new Uint8Array([1, 2, 3]) }), /aws_mcp_signing_body_rejected/);
  await assert.rejects(signing(AWS_MCP_ENDPOINT, { method: 'POST' }), /aws_mcp_signing_body_rejected/);
  await assert.rejects(
    signing(AWS_MCP_ENDPOINT, { method: 'POST', body: 'x'.repeat(AWS_MCP_MAX_REQUEST_BODY_BYTES + 1) }),
    /aws_mcp_request_too_large/,
  );
  assert.equal(sent.length, 0);
  await signing(AWS_MCP_ENDPOINT, { method: 'POST', body: 'x'.repeat(AWS_MCP_MAX_REQUEST_BODY_BYTES) });
  assert.equal(sent.length, 1, 'a body exactly at the cap is allowed');
});

test('credentials are requested for every signed request, so a rotation is picked up immediately', async () => {
  let generation = 0;
  const { signing, sent, credentialCalls } = harness({
    getCredentials: async () => {
      generation += 1;
      return { ...CREDS, accessKeyId: `ASIA${'SYNTHETICROT'}${String(generation).padStart(4, '0')}` };
    },
  });
  await signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}' });
  await signing(AWS_MCP_ENDPOINT, { method: 'DELETE' });
  assert.equal(credentialCalls(), 2);
  const keyIdOf = (n: number): string => `ASIA${'SYNTHETICROT'}${String(n).padStart(4, '0')}`;
  assert.ok(sent[0].init.headers.Authorization.includes(`Credential=${keyIdOf(1)}/`));
  assert.ok(sent[1].init.headers.Authorization.includes(`Credential=${keyIdOf(2)}/`));
});

test('a failing credential provider stops the request before it is sent', async () => {
  const { signing, sent } = harness({
    getCredentials: async () => {
      throw new Error('aws_mcp_unavailable (synthetic)');
    },
  });
  await assert.rejects(signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}' }), /aws_mcp_unavailable/);
  assert.equal(sent.length, 0);
});

test('each request is bounded by the time remaining in the call deadline', async () => {
  const { signing } = harness({
    remainingMs: () => 40,
    reply: (sent) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = sent.init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const release = holdEventLoop();
  try {
    const started = Date.now();
    await assert.rejects(signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}' }), (err: unknown) => (err as Error).name === 'TimeoutError');
    assert.ok(Date.now() - started < 2_000);
  } finally {
    release();
  }
});

test('a caller abort signal is honoured alongside the timeout', async () => {
  const controller = new AbortController();
  const { signing } = harness({
    reply: (sent) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = sent.init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const release = holdEventLoop();
  try {
    const pending = signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}', signal: controller.signal });
    // Let the signed request reach the fake network before the caller gives up.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('caller-abort'));
    await assert.rejects(pending, /caller-abort/);
  } finally {
    release();
  }
});

test('a response within the cap passes through unchanged', async () => {
  const text = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
  const { signing } = harness({ reply: () => new Response(text, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' } }) });
  const res = await signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(res.headers.get('mcp-session-id'), 'abc');
  assert.equal(await res.text(), text);
});

test('a response body larger than the cap is cut off with an error and reported once', async () => {
  let oversized = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const { signing } = harness({
    onOversizedResponse: () => {
      oversized += 1;
    },
    reply: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      ),
  });
  const res = await signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}' });
  await assert.rejects(res.arrayBuffer(), /aws_mcp_response_too_large/);
  assert.equal(oversized, 1);
  assert.ok(AWS_MCP_MAX_UPSTREAM_BODY_BYTES >= 1024 * 1024);
});

test('an error status is returned as-is so the transport can classify it', async () => {
  const { signing } = harness({ reply: () => new Response('{"__type":"AccessDeniedException"}', { status: 403 }) });
  const res = await signing(AWS_MCP_ENDPOINT, { method: 'POST', body: '{}' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /AccessDeniedException/);
});
