import { createHash, createHmac, randomBytes } from 'node:crypto';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { request as httpsRequest } from 'node:https';
import type { RedactedReceipt } from './policy.js';
import { redactedReceipt, validatePublicTargets } from './policy.js';

export interface AgentCoreBrowserTransport {
  inspect(targets: URL[], maxSeconds: number): Promise<RedactedReceipt[]>;
}

export class AgentCoreBrowserTransportError extends Error {
  readonly code: string;
  readonly nextStep: string;
  constructor(code: string, message: string, nextStep: string) {
    super(message);
    this.name = 'AgentCoreBrowserTransportError';
    this.code = code;
    this.nextStep = nextStep;
  }
}

export interface AgentCoreRuntimeConfig {
  enabled: boolean;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface AgentCoreSession {
  browserIdentifier: string;
  sessionId: string;
  automationEndpoint: string;
}

interface CdpResult {
  title: string | null;
  url: string | null;
  status: number | null;
}

/**
 * Credentials are injected into the runtime from Azure Key Vault as local Container Apps secrets.
 * This module never reads Key Vault directly and never serializes credentials, browser profiles,
 * CDP endpoints, HTML, screenshots, cookies, or session identifiers.
 */
export function agentCoreRuntimeConfig(env: Record<string, string | undefined> = process.env): AgentCoreRuntimeConfig {
  return {
    enabled: env.ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY === 'true',
    region: env.AWS_AGENTCORE_REGION || env.AWS_REGION || 'us-east-1',
    accessKeyId: env.AWS_AGENTCORE_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: env.AWS_AGENTCORE_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || '',
    sessionToken: env.AWS_AGENTCORE_SESSION_TOKEN || env.AWS_SESSION_TOKEN || '',
  };
}

export function assertAgentCoreConfigured(config = agentCoreRuntimeConfig()): void {
  if (!config.enabled) {
    throw new AgentCoreBrowserTransportError('provider_disabled', 'AgentCore public-read-only provider is disabled.', 'Keep ENABLE_AGENTCORE_WEFUNDER_PUBLIC_READONLY=false until the reviewed deployment binds the dedicated runtime identity.');
  }
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new AgentCoreBrowserTransportError('provider_unconfigured', 'AgentCore runtime credentials are not configured.', 'Bind the dedicated least-privilege AWS runtime credentials from Azure Key Vault to the gateway Container App; do not place values in source or logs.');
  }
}

function hmac(key: Buffer | string, value: string): Buffer { return createHmac('sha256', key).update(value, 'utf8').digest(); }
function randomClientToken(): string { return randomBytes(24).toString('hex'); }

interface SignedRequest {
  method: string;
  path: string;
  body: Buffer;
  headers: Record<string, string>;
}

type AgentCoreSigningConfig = Pick<AgentCoreRuntimeConfig, 'region' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>;

function signedAgentCoreRequest(config: AgentCoreSigningConfig, method: string, path: string, body: Buffer, now = new Date()): SignedRequest {
  const service = 'bedrock-agentcore';
  const host = `${service}.${config.region}.amazonaws.com`;
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').replace('Z', 'Z');
  const day = stamp.slice(0, 8);
  const [pathname, query = ''] = path.split('?', 2);
  const headers: Record<string, string> = { 'content-type': 'application/json', host, 'x-amz-date': stamp };
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${headers[key]}\n`).join('');
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const canonicalRequest = `${method}\n${pathname}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${day}/${config.region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const kDate = hmac(`AWS4${config.secretAccessKey}`, day);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, service);
  const signingKey = hmac(kService, 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString('hex')}`;
  return { method, path, body, headers };
}

/** Exported for deterministic unit tests; no request is sent here. */
export function signAgentCoreListBrowsers(config: Required<Pick<AgentCoreRuntimeConfig, 'region' | 'accessKeyId' | 'secretAccessKey'>> & Pick<AgentCoreRuntimeConfig, 'sessionToken'>, now = new Date()): Record<string, string> {
  return signedAgentCoreRequest(config, 'GET', '/browsers', Buffer.alloc(0), now).headers;
}

export function buildAgentCoreStartRequest(maxSeconds: number): { name: string; sessionTimeoutSeconds: number; viewPort: { width: number; height: number }; clientToken: string } {
  return {
    name: 'wefunder-public-readonly',
    // AgentCore requires at least 60 seconds. The gateway enforces the shorter caller deadline itself.
    sessionTimeoutSeconds: Math.max(60, Math.min(maxSeconds, 300)),
    viewPort: { width: 1440, height: 900 },
    clientToken: randomClientToken(),
  };
}

async function invokeSigned(config: AgentCoreRuntimeConfig, method: string, path: string, payload: unknown): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(payload));
  const signed = signedAgentCoreRequest(config, method, path, body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: signed.headers.host, method: signed.method, path: signed.path, headers: { ...signed.headers, 'content-length': String(signed.body.length) }, timeout: 20_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          reject(new AgentCoreBrowserTransportError('provider_request_failed', `AgentCore returned HTTP ${res.statusCode ?? 500}.`, 'No page result was returned. Confirm the dedicated runtime IAM policy permits only the required browser session actions.'));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { reject(new AgentCoreBrowserTransportError('provider_response_invalid', 'AgentCore returned an unreadable session response.', 'No page result was returned and no browser state was retained by the gateway.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new AgentCoreBrowserTransportError('provider_connection_failed', 'AgentCore session transport was unavailable.', 'No page result was returned. Check the dedicated runtime network and IAM configuration.')));
    req.end(signed.body);
  });
}

function sessionFrom(value: unknown): AgentCoreSession {
  const response = value as { browserIdentifier?: unknown; sessionId?: unknown; streams?: { automationStream?: { streamEndpoint?: unknown } } };
  const browserIdentifier = typeof response.browserIdentifier === 'string' ? response.browserIdentifier : '';
  const sessionId = typeof response.sessionId === 'string' ? response.sessionId : '';
  const automationEndpoint = typeof response.streams?.automationStream?.streamEndpoint === 'string' ? response.streams.automationStream.streamEndpoint : '';
  if (!browserIdentifier || !sessionId || !automationEndpoint) {
    throw new AgentCoreBrowserTransportError('provider_session_invalid', 'AgentCore did not return a usable browser automation stream.', 'No browser content was returned. Check the AgentCore Browser service contract and runtime IAM policy.');
  }
  return { browserIdentifier, sessionId, automationEndpoint };
}

function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

class CdpSocket {
  private readonly socket: TLSSocket;
  private pending = Buffer.alloc(0);
  private frames: string[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private nextId = 1;

  private constructor(socket: TLSSocket) { this.socket = socket; }

  static async connect(endpoint: string, signedHeaders: Record<string, string>): Promise<CdpSocket> {
    const url = new URL(endpoint);
    if (url.protocol !== 'wss:') throw new AgentCoreBrowserTransportError('provider_stream_invalid', 'AgentCore returned a non-secure automation stream.', 'No browser content was returned.');
    const socket = connectTls({ host: url.hostname, port: Number(url.port || '443'), servername: url.hostname });
    const client = new CdpSocket(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AgentCoreBrowserTransportError('provider_stream_timeout', 'AgentCore automation stream did not connect in time.', 'No browser content was returned.')), 15_000);
      socket.once('error', () => { clearTimeout(timer); reject(new AgentCoreBrowserTransportError('provider_stream_failed', 'AgentCore automation stream could not connect.', 'No browser content was returned.')); });
      socket.once('secureConnect', () => {
        const key = randomBytes(16).toString('base64');
        const requestHeaders = Object.entries(signedHeaders)
          .filter(([name]) => name !== 'host' && name !== 'content-type')
          .map(([name, value]) => `${name}: ${value}`)
          .join('\r\n');
        const request = `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${requestHeaders}\r\n\r\n`;
        socket.write(request);
      });
      const original = client.acceptHandshake.bind(client);
      socket.on('data', (chunk: Buffer) => {
        try {
          if (original(chunk)) { clearTimeout(timer); resolve(); }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    });
    socket.on('error', () => client.notify());
    socket.on('close', () => { client.closed = true; client.notify(); });
    return client;
  }

  private handshaken = false;
  private acceptHandshake(chunk: Buffer): boolean {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (!this.handshaken) {
      const marker = this.pending.indexOf('\r\n\r\n');
      if (marker < 0) return false;
      const response = this.pending.subarray(0, marker).toString('utf8');
      if (!/^HTTP\/1\.1 101\b/m.test(response)) {
        throw new AgentCoreBrowserTransportError('provider_stream_rejected', 'AgentCore rejected the automation stream handshake.', 'No browser content was returned. Check the browser stream IAM permissions.');
      }
      this.pending = this.pending.subarray(marker + 4);
      this.handshaken = true;
    }
    this.consumeFrames();
    return true;
  }

  private consumeFrames(): void {
    while (this.pending.length >= 2) {
      const first = this.pending[0];
      const second = this.pending[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) { if (this.pending.length < 4) return; length = this.pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) { throw new AgentCoreBrowserTransportError('provider_stream_frame_invalid', 'AgentCore returned an oversized browser stream frame.', 'No browser content was returned.'); }
      if (this.pending.length < offset + length) return;
      const opcode = first & 0x0f;
      const payload = this.pending.subarray(offset, offset + length);
      this.pending = this.pending.subarray(offset + length);
      if (opcode === 0x1) this.frames.push(payload.toString('utf8'));
      if (opcode === 0x9) this.writeFrame(0xA, payload);
      if (opcode === 0x8) this.closed = true;
      this.notify();
    }
  }

  private notify(): void { const wake = this.wake; this.wake = undefined; wake?.(); }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else throw new AgentCoreBrowserTransportError('provider_stream_frame_invalid', 'Browser automation request exceeded the bounded stream frame size.', 'No browser content was returned.');
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private async nextFrame(timeoutMilliseconds: number): Promise<string> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (this.frames.length === 0) {
      if (this.closed) throw new AgentCoreBrowserTransportError('provider_stream_closed', 'AgentCore closed the automation stream before inspection completed.', 'No browser content was returned.');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AgentCoreBrowserTransportError('provider_stream_timeout', 'AgentCore browser inspection exceeded its bounded timeout.', 'No browser content was returned.');
      await Promise.race([new Promise<void>((resolve) => { this.wake = resolve; }), sleep(remaining)]);
    }
    return this.frames.shift() as string;
  }

  async request(method: string, params: Record<string, unknown>, timeoutMilliseconds: number): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    this.writeFrame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    const deadline = Date.now() + timeoutMilliseconds;
    while (true) {
      const raw = await this.nextFrame(Math.max(1, deadline - Date.now()));
      let message: { id?: unknown; error?: { message?: unknown }; result?: unknown };
      try { message = JSON.parse(raw) as { id?: unknown; error?: { message?: unknown }; result?: unknown }; }
      catch { continue; }
      if (message.id !== id) continue;
      if (message.error) throw new AgentCoreBrowserTransportError('provider_cdp_failed', 'AgentCore rejected the bounded public inspection command.', 'No browser content was returned.');
      return (message.result ?? {}) as Record<string, unknown>;
    }
  }

  async close(): Promise<void> {
    if (!this.closed) this.writeFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.closed = true;
  }
}

function streamHeaders(config: AgentCoreRuntimeConfig, endpoint: string): Record<string, string> {
  const url = new URL(endpoint);
  return signedAgentCoreRequest(config, 'GET', `${url.pathname}${url.search}`, Buffer.alloc(0)).headers;
}

function evaluatedResult(value: Record<string, unknown>): CdpResult {
  const result = value.result as { result?: { value?: unknown } } | undefined;
  const serialized = result?.result?.value;
  if (typeof serialized !== 'string') throw new AgentCoreBrowserTransportError('provider_result_invalid', 'AgentCore did not return a bounded public page receipt.', 'No browser content was returned.');
  let parsed: { title?: unknown; url?: unknown; status?: unknown };
  try { parsed = JSON.parse(serialized) as { title?: unknown; url?: unknown; status?: unknown }; }
  catch { throw new AgentCoreBrowserTransportError('provider_result_invalid', 'AgentCore did not return a bounded public page receipt.', 'No browser content was returned.'); }
  return {
    title: typeof parsed.title === 'string' ? parsed.title : null,
    url: typeof parsed.url === 'string' ? parsed.url : null,
    status: typeof parsed.status === 'number' && Number.isInteger(parsed.status) && parsed.status >= 100 && parsed.status <= 599 ? parsed.status : null,
  };
}

export class AwsAgentCorePublicReadOnlyTransport implements AgentCoreBrowserTransport {
  constructor(private readonly config: AgentCoreRuntimeConfig = agentCoreRuntimeConfig()) {}

  async inspect(targets: URL[], maxSeconds: number): Promise<RedactedReceipt[]> {
    assertAgentCoreConfigured(this.config);
    const started = Date.now();
    const response = await invokeSigned(this.config, 'PUT', '/browsers/aws.browser.v1/sessions/start', buildAgentCoreStartRequest(maxSeconds));
    const session = sessionFrom(response);
    const receipts: RedactedReceipt[] = [];
    let cleanupSuccess = false;
    let socket: CdpSocket | undefined;
    try {
      socket = await CdpSocket.connect(session.automationEndpoint, streamHeaders(this.config, session.automationEndpoint));
      for (const target of targets) {
        const remaining = maxSeconds * 1000 - (Date.now() - started);
        if (remaining <= 0) throw new AgentCoreBrowserTransportError('provider_timeout', 'AgentCore browser inspection exceeded its bounded deadline.', 'No additional page was inspected.');
        await socket.request('Page.navigate', { url: target.toString() }, Math.min(remaining, 20_000));
        await sleep(Math.min(750, Math.max(1, remaining)));
        const inspected = evaluatedResult(await socket.request('Runtime.evaluate', { expression: "JSON.stringify({title:document.title,url:location.href,status:performance.getEntriesByType('navigation')[0]?.responseStatus ?? null})", returnByValue: true }, Math.min(remaining, 20_000)));
        if (!inspected.url || !validatePublicTargets([inspected.url]).ok) {
          throw new AgentCoreBrowserTransportError('redirect_outside_allowlist', 'A public target redirected outside the strict browser allowlist.', 'No page content or external destination was returned.');
        }
        receipts.push(redactedReceipt(target, inspected.status, inspected.title, inspected.url, false));
      }
    } finally {
      try { await socket?.close(); }
      catch { /* StopBrowserSession below remains authoritative cleanup. */ }
      try {
        await invokeSigned(this.config, 'PUT', `/browsers/${encodeURIComponent(session.browserIdentifier)}/sessions/stop?sessionId=${encodeURIComponent(session.sessionId)}`, { clientToken: randomClientToken() });
        cleanupSuccess = true;
      } catch {
        throw new AgentCoreBrowserTransportError('session_cleanup_failed', 'The AgentCore browser session could not be confirmed stopped.', 'Treat the run as failed and inspect the AWS session record before another browser invocation.');
      }
    }
    return receipts.map((receipt) => ({ ...receipt, cleanup_success: cleanupSuccess }));
  }
}

/** Retained for deterministic disabled-runtime tests only; production registration uses AwsAgentCorePublicReadOnlyTransport. */
export class UnconfiguredAgentCoreBrowserTransport implements AgentCoreBrowserTransport {
  async inspect(_targets: URL[], _maxSeconds: number): Promise<RedactedReceipt[]> {
    throw new AgentCoreBrowserTransportError('runtime_adapter_unconfigured', 'AgentCore policy passed, but the session transport is intentionally not configured.', 'Complete the reviewed transport deployment before enabling public inspection; no browser session was created.');
  }
}
