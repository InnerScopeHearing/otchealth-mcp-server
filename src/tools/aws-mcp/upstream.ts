/**
 * Upstream session handling for the AWS MCP bridge.
 *
 * Every bridge call opens its own short MCP session against the AWS MCP Server using the
 * @modelcontextprotocol/sdk client (initialize, one operation, best-effort session termination),
 * with every HTTP request SigV4-signed by signed-fetch.ts using the reader-role credentials.
 *
 * WHY A SESSION PER CALL. The gateway runs as several ECS tasks behind a load balancer, and a
 * session is bound to the signing identity, so a session cached in one task could not be reused by
 * the next call anyway. A per-call session keeps credential rotation trivial and leaks no sandbox
 * state between callers. The consequence, documented in the tool descriptions: nothing persists
 * between calls (no files in the upstream sandbox, no task handles), so scripts must be
 * self-contained.
 *
 * LIMITS (AWS MCP Server quotas: 10 authenticated requests per second per account, 100 concurrent
 * connections). A small in-process semaphore bounds concurrent sessions per gateway task, an overall
 * deadline bounds each call, and the response body is capped. Nothing here retries.
 *
 * FAIL CLOSED. Reader credentials are obtained before the first request to the AWS MCP Server. If
 * they are unavailable the call ends with AwsReaderUnavailableError and no request is ever sent.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AwsCredentials } from '../../search/sigv4.js';
import { AwsReaderUnavailableError, type ReaderIdentity } from './credentials.js';
import { redactCredentialShapes, stripControlChars } from './output.js';
import {
  AWS_MCP_ENDPOINT,
  createSigningFetch,
  resolveSigningScope,
  type FetchLike,
  type SigningScope,
} from './signed-fetch.js';

/** Overall wall-clock budget for one bridge call. Kept well under the 60s default ALB idle timeout. */
export const AWS_MCP_DEADLINE_MS = 45_000;
export const AWS_MCP_QUEUE_WAIT_MS = 10_000;
export const AWS_MCP_MAX_CONCURRENT_SESSIONS = 2;
export const AWS_MCP_MAX_LIST_PAGES = 5;
const TERMINATE_SESSION_TIMEOUT_MS = 3_000;
const MAX_ERROR_DETAIL_CHARS = 300;
const DEFAULT_REGION = 'us-east-1';

export type AwsMcpBridgeErrorCode =
  | 'aws_mcp_timeout'
  | 'aws_mcp_busy'
  | 'aws_mcp_throttled'
  | 'aws_mcp_rejected'
  | 'aws_mcp_upstream_http'
  | 'aws_mcp_upstream_error'
  | 'aws_mcp_network'
  | 'aws_mcp_response_too_large'
  | 'aws_mcp_protocol';

/** A bridge-side failure with a fixed, caller-safe message. */
export class AwsMcpBridgeError extends Error {
  readonly code: AwsMcpBridgeErrorCode;
  constructor(code: AwsMcpBridgeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AwsMcpBridgeError';
    this.code = code;
  }
}

/** Counting semaphore with a bounded wait. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(maxWaitMs: number): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.active += 1;
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new AwsMcpBridgeError('aws_mcp_busy', 'too many AWS bridge calls are already running; retry in a moment.'));
      }, Math.max(1, maxWaitMs));
      this.waiters.push(wake);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

const defaultLimiter = new Semaphore(AWS_MCP_MAX_CONCURRENT_SESSIONS);

/**
 * tools/list is read with a deliberately tolerant schema and through client.request() rather than
 * client.listTools(): listTools() also compiles every advertised outputSchema with a JSON Schema
 * validator, work this bridge neither needs nor wants to depend on.
 */
const ListToolsPageSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string(),
          description: z.string().optional(),
          inputSchema: z.unknown().optional(),
          annotations: z.unknown().optional(),
        })
        .passthrough(),
    ),
    nextCursor: z.string().optional(),
  })
  .passthrough();

export interface UpstreamDeps {
  /**
   * Reader-role credentials (never the gateway's own). `sessionHint` only names a new STS session.
   * The reader provider also reports which role session the credentials came from; it is passed
   * back to the caller so the result can say which role was actually assumed.
   */
  getCredentials: (sessionHint: string) => Promise<AwsCredentials & Partial<ReaderIdentity>>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  deadlineMs?: number;
  limiter?: Semaphore;
  scope?: SigningScope;
}

export interface UpstreamTool {
  name: string;
  description: string | undefined;
  inputSchema: unknown;
  annotations: unknown;
}

export interface UpstreamCallResult {
  isError: boolean;
  /** Text from text blocks and embedded text resources, one string per block. */
  texts: string[];
  /** Image, audio, resource-link and binary blocks that were not returned. */
  omittedNonTextBlocks: number;
  /** The reader role session that signed the call, when the credential provider reports it. */
  identity: ReaderIdentity | undefined;
}

export interface UpstreamListResult {
  tools: UpstreamTool[];
  /** The reader role session that signed the call, when the credential provider reports it. */
  identity: ReaderIdentity | undefined;
}

interface SessionControl {
  signal: AbortSignal;
  remainingMs: () => number;
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function safeDetail(raw: string): string {
  const { text } = redactCredentialShapes(stripControlChars(raw).replace(/\s+/g, ' ').trim());
  return text.length > MAX_ERROR_DETAIL_CHARS ? `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}...` : text;
}

/** Pull a short error type token and message out of an AWS-style JSON error body, if there is one. */
function describeHttpBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const type = [parsed.__type, parsed.code, parsed.Code, parsed.errorCode].find((v): v is string => typeof v === 'string');
    const message = [parsed.message, parsed.Message, parsed.errorMessage].find((v): v is string => typeof v === 'string');
    const parts = [
      type && /^[A-Za-z0-9._:#-]{1,120}$/.test(type) ? type : undefined,
      message ? safeDetail(message) : undefined,
    ].filter(Boolean);
    if (parts.length) return parts.join(': ');
  } catch {
    // not JSON: fall through to the raw snippet
  }
  return safeDetail(body);
}

function mapUpstreamError(err: unknown, context: { oversized: boolean; deadlineHit: boolean }): Error {
  if (err instanceof AwsReaderUnavailableError || err instanceof AwsMcpBridgeError) return err;
  if (context.oversized) {
    return new AwsMcpBridgeError('aws_mcp_response_too_large', 'the AWS MCP Server response exceeded the bridge size limit; narrow the request.');
  }
  if (context.deadlineHit || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))) {
    return new AwsMcpBridgeError('aws_mcp_timeout', 'the AWS MCP Server did not answer within the bridge time limit; narrow the request or retry.');
  }
  if (err instanceof StreamableHTTPError) {
    // The SDK reuses `code` for non-HTTP transport failures (for example -1), so only a real HTTP status counts.
    const status = typeof err.code === 'number' && err.code >= 100 && err.code <= 599 ? err.code : 0;
    // The SDK message embeds the response body after a fixed prefix.
    const body = err.message.replace(/^Streamable HTTP error: (?:Error POSTing to endpoint: )?/, '');
    if (status === 429) {
      return new AwsMcpBridgeError('aws_mcp_throttled', 'the AWS MCP Server throttled the request (HTTP 429; the account limit is about 10 requests per second); retry shortly.');
    }
    if (status === 401 || status === 403) {
      return new AwsMcpBridgeError(
        'aws_mcp_rejected',
        `the AWS MCP Server rejected the signed request (HTTP ${status}): ${describeHttpBody(body)}. ` +
          'This points at the reader role permissions or the SigV4 signing scope, not at the CTO request.',
      );
    }
    return new AwsMcpBridgeError(
      'aws_mcp_upstream_http',
      status
        ? `the AWS MCP Server answered HTTP ${status}: ${describeHttpBody(body)}`
        : `the AWS MCP Server sent an unexpected response: ${describeHttpBody(body)}`,
    );
  }
  if (err instanceof McpError) {
    // The SDK's own per-request timer can fire in the same instant as the call deadline; both are timeouts.
    if (err.code === ErrorCode.RequestTimeout) {
      return new AwsMcpBridgeError('aws_mcp_timeout', 'the AWS MCP Server did not answer within the bridge time limit; narrow the request or retry.');
    }
    if (err.code === ErrorCode.ConnectionClosed) {
      return new AwsMcpBridgeError('aws_mcp_network', 'the connection to the AWS MCP Server closed before a response arrived.');
    }
    return new AwsMcpBridgeError('aws_mcp_upstream_error', `the AWS MCP Server returned an MCP error (code ${String(err.code)}): ${safeDetail(err.message)}`);
  }
  if (err instanceof TypeError) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(cause.code) ? ` (${cause.code})` : '';
    return new AwsMcpBridgeError('aws_mcp_network', `could not reach the AWS MCP Server${code}.`);
  }
  return new AwsMcpBridgeError('aws_mcp_protocol', 'the AWS MCP Server session failed unexpectedly.');
}

async function shutdown(transport: StreamableHTTPClientTransport | undefined, client: Client | undefined): Promise<void> {
  if (transport?.sessionId) {
    const wait = delay(TERMINATE_SESSION_TIMEOUT_MS);
    try {
      await Promise.race([transport.terminateSession(), wait.promise]);
    } catch {
      // best effort: the upstream session expires on its own
    } finally {
      wait.cancel();
    }
  }
  try {
    await client?.close();
  } catch {
    // nothing left to release
  }
}

/** Run one operation inside a fresh, signed upstream MCP session. */
async function withUpstreamSession<T>(
  deps: UpstreamDeps,
  sessionHint: string,
  operation: (client: Client, control: SessionControl) => Promise<T>,
): Promise<{ value: T; identity: ReaderIdentity | undefined }> {
  const deadlineMs = deps.deadlineMs ?? AWS_MCP_DEADLINE_MS;
  const startedAt = Date.now();
  const remainingMs = (): number => Math.max(0, deadlineMs - (Date.now() - startedAt));
  const abort = new AbortController();
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    abort.abort(new AwsMcpBridgeError('aws_mcp_timeout', 'the AWS MCP Server did not answer within the bridge time limit; narrow the request or retry.'));
  }, deadlineMs);

  let oversized = false;
  let transport: StreamableHTTPClientTransport | undefined;
  let client: Client | undefined;
  let release: (() => void) | undefined;
  try {
    release = await (deps.limiter ?? defaultLimiter).acquire(Math.min(AWS_MCP_QUEUE_WAIT_MS, deadlineMs));

    // Only the three signing fields are ever handed to the signer; the identity stays here.
    let identity: ReaderIdentity | undefined;
    const signingCredentials = async (): Promise<AwsCredentials> => {
      const credentials = await deps.getCredentials(sessionHint);
      if (credentials.roleArn && credentials.roleSessionName) {
        identity = { roleArn: credentials.roleArn, roleSessionName: credentials.roleSessionName };
      }
      return {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      };
    };

    // Fail closed before any request leaves for the AWS MCP Server.
    await signingCredentials();

    const signingFetch = createSigningFetch({
      scope: deps.scope ?? resolveSigningScope(),
      getCredentials: signingCredentials,
      fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
      now: deps.now,
      remainingMs,
      onOversizedResponse: () => {
        oversized = true;
      },
    });
    transport = new StreamableHTTPClientTransport(new URL(AWS_MCP_ENDPOINT), {
      fetch: signingFetch,
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    client = new Client({ name: 'otchealth-gateway-aws-bridge', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport, { signal: abort.signal, timeout: Math.max(1, remainingMs()) });
    const value = await operation(client, { signal: abort.signal, remainingMs });
    return { value, identity };
  } catch (err) {
    throw mapUpstreamError(err, { oversized, deadlineHit });
  } finally {
    clearTimeout(timer);
    await shutdown(transport, client);
    release?.();
  }
}

/** List the tools the AWS MCP Server advertises (names, descriptions, input schemas). */
export async function listUpstreamTools(deps: UpstreamDeps, sessionHint: string): Promise<UpstreamListResult> {
  const { value, identity } = await withUpstreamSession(deps, sessionHint, async (client, control) => {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < AWS_MCP_MAX_LIST_PAGES; page += 1) {
      const result = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, ListToolsPageSchema, {
        signal: control.signal,
        timeout: Math.max(1, control.remainingMs()),
      });
      for (const tool of result.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  });
  return { tools: value, identity };
}

/** Call one upstream tool and return its text output. */
export async function callUpstreamTool(
  deps: UpstreamDeps,
  sessionHint: string,
  toolName: string,
  args: Record<string, unknown>,
  region: string = DEFAULT_REGION,
): Promise<UpstreamCallResult> {
  const { value, identity } = await withUpstreamSession(deps, sessionHint, async (client, control) => {
    const result = await client.callTool(
      // _meta.AWS_REGION is how the AWS MCP Server learns the default region for SigV4 callers.
      { name: toolName, arguments: args, _meta: { AWS_REGION: region } },
      undefined,
      { signal: control.signal, timeout: Math.max(1, control.remainingMs()), maxTotalTimeout: Math.max(1, control.remainingMs()) },
    );
    const texts: string[] = [];
    let omitted = 0;
    const blocks = Array.isArray(result.content) ? result.content : [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block.type === 'resource' && typeof (block.resource as { text?: unknown }).text === 'string') {
        texts.push((block.resource as { text: string }).text);
      } else {
        omitted += 1;
      }
    }
    if (texts.length === 0 && result.structuredContent !== undefined) {
      texts.push(JSON.stringify(result.structuredContent));
    }
    return { isError: result.isError === true, texts, omittedNonTextBlocks: omitted };
  });
  return { ...value, identity };
}
