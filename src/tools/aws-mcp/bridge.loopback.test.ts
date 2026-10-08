/**
 * The bridge over a REAL HTTP stack. bridge.test.ts drives the bridge against a fake fetch; these
 * tests send the same requests through Node's real fetch to a loopback server standing in for the
 * AWS MCP Server, so what is checked here is what would actually be on the wire: the signature is
 * recomputed from the received bytes, redirects are refused, a hung server is cut off, and an
 * endless body is abandoned. Nothing leaves the machine; the only address used is 127.0.0.1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

Object.assign(process.env, {
  CIO_SITE_ID: 'synthetic-site',
  CIO_TRACK_KEY: 'synthetic-track',
  CIO_APP_API_BEARER: 'synthetic-app',
  PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'a'.repeat(32),
  N8N_WEBHOOK_SECRET: 'n'.repeat(32),
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
});
delete process.env.AWS_AI_READER_ROLE_ARN;
delete process.env.AWS_MCP_SIGNING_SERVICE;

const bridge = await import('./tools.js');
const { AwsMcpBridgeError } = await import('./upstream.js');

// Synthetic reader credentials; key-shaped literals are assembled so no source line looks like a credential.
const CREDS = {
  accessKeyId: 'ASIA' + 'SYNTHETICLOOP01',
  secretAccessKey: 'synthetic-loopback-secret-not-real',
  sessionToken: 'synthetic-loopback-session-token',
};
// The only caller the bridge serves: the CTO lane over an OAuth session.
const CTO = { callerAgent: 'cto', correlationId: 'corr-loopback-0001', callerHash: 'c0ffee'.repeat(10) + 'c0ff', authKind: 'oauth' as const };
const AWS_ORIGIN = 'https://aws-mcp.us-east-1.api.aws';
const AWS_HOST = 'aws-mcp.us-east-1.api.aws';

const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** What AWS would do: recompute the SigV4 signature from the request exactly as received. */
function wireSignatureProblems(req: http.IncomingMessage, body: string): string[] {
  const authorization = String(req.headers.authorization ?? '');
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!match) return ['malformed Authorization header'];
  const [, keyId, dateStamp, region, service, signedList, signature] = match;
  const problems: string[] = [];
  if (keyId !== CREDS.accessKeyId) problems.push('unexpected access key id');
  if (region !== 'us-east-1' || service !== 'aws-mcp') problems.push(`unexpected scope ${region}/${service}`);
  const amzDate = String(req.headers['x-amz-date'] ?? '');
  if (!amzDate.startsWith(dateStamp)) problems.push('x-amz-date does not match the credential scope date');
  const names = signedList.split(';');
  for (const required of ['host', 'x-amz-date', 'x-amz-security-token']) {
    if (!names.includes(required)) problems.push(`${required} is not signed`);
  }
  const headerBlock = names.map((n) => `${n}:${n === 'host' ? AWS_HOST : String(req.headers[n] ?? '').trim()}`).join('\n');
  const canonicalRequest = [req.method, '/mcp', '', headerBlock, '', signedList, sha256Hex(body)].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, `${dateStamp}/${region}/${service}/aws4_request`, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + CREDS.secretAccessKey, dateStamp), region), service), 'aws4_request');
  const expected = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  if (expected !== signature) problems.push('signature does not match the received bytes');
  if (req.headers['x-amz-security-token'] !== CREDS.sessionToken) problems.push('unexpected security token');
  return problems;
}

interface Loopback {
  port: number;
  requests: string[];
  problems: string[];
  close: () => Promise<void>;
}

type Route = (rpc: { id?: number | string; method?: string; params?: Record<string, unknown> }, req: http.IncomingMessage, res: http.ServerResponse) => boolean | void;

/** A loopback MCP endpoint. `route` may take over a response (return true); otherwise defaults apply. */
async function startLoopback(options: { sse?: boolean; route?: Route } = {}): Promise<Loopback> {
  const requests: string[] = [];
  const problems: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      for (const problem of wireSignatureProblems(req, body)) problems.push(`${req.method}: ${problem}`);
      const rpc = body ? (JSON.parse(body) as { id?: number | string; method?: string; params?: Record<string, unknown> }) : undefined;
      requests.push(req.method === 'POST' ? `POST ${rpc?.method ?? '?'}` : String(req.method));
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      if (!rpc) {
        res.writeHead(405).end();
        return;
      }
      if (options.route?.(rpc, req, res)) return;
      const reply = (result: unknown, extra: Record<string, string> = {}): void => {
        const message = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
        if (options.sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream', ...extra }).end(`event: message\ndata: ${message}\n\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json', ...extra }).end(message);
        }
      };
      if (rpc.method === 'initialize') {
        reply(
          { protocolVersion: (rpc.params as { protocolVersion: string }).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'loopback-aws-mcp', version: '0.0.0' } },
          { 'mcp-session-id': 'sess-loopback-1' },
        );
      } else if (rpc.method === 'notifications/initialized') {
        res.writeHead(202).end();
      } else if (rpc.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: `loopback saw ${(rpc.params as { name: string }).name}` }] });
      } else {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    problems,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Real fetch, with the AWS origin redirected to the loopback server. */
function realFetchTo(port: number) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => fetch(String(url).replace(AWS_ORIGIN, `http://127.0.0.1:${port}`), init);
}

const deps = (port: number, extra: Record<string, unknown> = {}) => ({
  getCredentials: async () => CREDS,
  fetchImpl: realFetchTo(port),
  ...extra,
});

for (const sse of [false, true]) {
  test(`over real HTTP (${sse ? 'SSE' : 'JSON'} replies): every request verifies as SigV4 on the wire and no event stream is opened`, async () => {
    const lb = await startLoopback({ sse });
    try {
      const result = await bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, deps(lb.port));
      assert.equal(result.content_text, 'loopback saw aws___list_regions');
      assert.deepEqual(lb.requests, ['POST initialize', 'POST notifications/initialized', 'POST tools/call', 'DELETE']);
      assert.deepEqual(lb.problems, [], 'the signature recomputed from the received bytes matches on every request');
    } finally {
      await lb.close();
    }
  });
}

test('over real HTTP: a redirect is refused and the signed headers never follow it', async () => {
  const elsewhere = await startLoopback();
  const lb = await startLoopback({
    route: (rpc, _req, res) => {
      if (rpc.method !== 'initialize') return false;
      res.writeHead(307, { location: `http://127.0.0.1:${elsewhere.port}/mcp` }).end();
      return true;
    },
  });
  try {
    await assert.rejects(
      bridge.callAwsMcpTool({ tool_name: 'aws___list_regions' }, CTO, deps(lb.port)),
      (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_network',
    );
    assert.deepEqual(elsewhere.requests, [], 'the redirect target never received the request');
  } finally {
    await lb.close();
    await elsewhere.close();
  }
});

test('over real HTTP: a server that never answers is cut off at the deadline and the connection is dropped', async () => {
  let dropped = false;
  const lb = await startLoopback({
    route: (rpc, req) => {
      if (rpc.method !== 'tools/call') return false;
      req.socket.on('close', () => {
        dropped = true;
      });
      return true; // never respond
    },
  });
  try {
    const started = Date.now();
    await assert.rejects(
      bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'x' } }, CTO, deps(lb.port, { deadlineMs: 400 })),
      (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_timeout',
    );
    assert.ok(Date.now() - started < 5_000);
    for (let i = 0; i < 50 && !dropped; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dropped, true, 'the abort reached the socket');
  } finally {
    await lb.close();
  }
});

test('over real HTTP: an endless response body is abandoned at the size cap', async () => {
  let written = 0;
  let stopped = false;
  const lb = await startLoopback({
    route: (rpc, _req, res) => {
      if (rpc.method !== 'tools/call') return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.on('close', () => {
        stopped = true;
      });
      const chunk = Buffer.alloc(64 * 1024, 120);
      const pump = (): void => {
        while (!stopped) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
      return true;
    },
  });
  try {
    await assert.rejects(
      bridge.callAwsMcpTool({ tool_name: 'aws___run_script', arguments: { script: 'x' } }, CTO, deps(lb.port)),
      (err: unknown) => err instanceof AwsMcpBridgeError && err.code === 'aws_mcp_response_too_large',
    );
    for (let i = 0; i < 50 && !stopped; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, true, 'the server saw the client hang up');
    assert.ok(written < 64 * 1024 * 1024, `the server was not allowed to stream without bound (${written} bytes written)`);
  } finally {
    await lb.close();
  }
});
