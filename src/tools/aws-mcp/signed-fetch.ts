/**
 * SigV4-signing `fetch` for the AWS MCP Server (https://aws-mcp.us-east-1.api.aws/mcp).
 *
 * The AWS MCP Server accepts AWS SigV4 as an authentication path (the same one the official
 * `mcp-proxy-for-aws` uses). This module supplies the @modelcontextprotocol/sdk
 * StreamableHTTPClientTransport with a `fetch` that signs every request it sends.
 *
 * SIGNING SCOPE. The credential scope is `<date>/<region>/<service>/aws4_request` with region
 * `us-east-1` and service `aws-mcp`. Both come from the endpoint host exactly as
 * mcp-proxy-for-aws 1.7.0 derives them: `utils.get_service_name_and_region_from_endpoint` matches
 * hosts of the form `[service, region, 'api', 'aws']` and returns (service, region), so
 * `aws-mcp.us-east-1.api.aws` yields ('aws-mcp', 'us-east-1'); `determine_service_name` and
 * `determine_signing_region` then use those values unless `--service` / `--region` override them.
 * `deriveSigningScope` below is the same rule, and AWS_MCP_SIGNING_SERVICE is the equivalent of
 * `--service`. The official AWS plugin configuration runs the proxy against this host without
 * `--service`, so the derived scope is the one AWS itself ships.
 *
 * WHAT IS SIGNED. host, x-amz-date, x-amz-security-token, content-type and every other header the MCP
 * transport sends (accept, mcp-session-id, mcp-protocol-version), through the signer in
 * src/search/sigv4.ts. botocore's SigV4Auth, which mcp-proxy-for-aws uses, likewise signs every header
 * on the request except user-agent, so signing the transport's headers keeps this request shaped like
 * the one AWS's own client sends. user-agent is the one header added after signing.
 *
 * HARD LIMITS. Only POST and DELETE are ever sent, only to the one endpoint, redirects are refused
 * (so the security-token header can never follow a redirect to another host), and the response body
 * is cut off once it exceeds a byte cap. A server-initiated GET event stream is never opened: a GET
 * is answered locally with 405, which the transport treats as "this server offers no GET stream".
 * Nothing here logs headers, signatures or tokens.
 */
import { signRequest, type AwsCredentials } from '../../search/sigv4.js';

export const AWS_MCP_ENDPOINT = 'https://aws-mcp.us-east-1.api.aws/mcp';
export const AWS_MCP_SIGNING_SERVICE_ENV = 'AWS_MCP_SIGNING_SERVICE';
/** Upstream body cap per response; anything larger is abandoned (the tool output cap is far smaller). */
export const AWS_MCP_MAX_UPSTREAM_BODY_BYTES = 2 * 1024 * 1024;
/** Request body cap: a script and its arguments are small; this only stops accidental floods. */
export const AWS_MCP_MAX_REQUEST_BODY_BYTES = 256 * 1024;

const SERVICE_OVERRIDE_PATTERN = /^[a-z0-9-]{2,40}$/;
const USER_AGENT = 'otchealth-mcp-gateway/aws-mcp-bridge';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface SigningScope {
  service: string;
  region: string;
}

/**
 * Derive the SigV4 service and region from an endpoint host, the way mcp-proxy-for-aws 1.7.0 does
 * (utils.get_service_name_and_region_from_endpoint, `case [service, region, 'api', 'aws']`).
 */
export function deriveSigningScope(hostname: string): SigningScope {
  const parts = hostname.split('.');
  if (parts.length === 4 && parts[2] === 'api' && parts[3] === 'aws' && parts[0] && parts[1]) {
    return { service: parts[0], region: parts[1] };
  }
  throw new Error('aws_mcp_signing_scope_underivable');
}

/** The signing scope for AWS_MCP_ENDPOINT, honouring the optional AWS_MCP_SIGNING_SERVICE override. */
export function resolveSigningScope(env: Record<string, string | undefined> = process.env): SigningScope {
  const derived = deriveSigningScope(new URL(AWS_MCP_ENDPOINT).hostname);
  const override = (env[AWS_MCP_SIGNING_SERVICE_ENV] ?? '').trim();
  if (!override) return derived;
  if (!SERVICE_OVERRIDE_PATTERN.test(override)) throw new Error('aws_mcp_signing_service_invalid');
  return { service: override, region: derived.region };
}

export interface SigningFetchOptions {
  scope: SigningScope;
  /** Reader-role credentials only. The caller is responsible for never passing base credentials. */
  getCredentials: () => Promise<AwsCredentials>;
  fetchImpl: FetchLike;
  now?: () => Date;
  /** Milliseconds left in the overall deadline; each request is bounded by it. */
  remainingMs: () => number;
  /** Called once when a response body exceeded AWS_MCP_MAX_UPSTREAM_BODY_BYTES. */
  onOversizedResponse?: () => void;
}

/** Headers the signer or the HTTP stack owns (user-agent is set after signing); any caller-supplied copy is dropped. */
const MANAGED_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'connection',
  'x-amz-date',
  'x-amz-security-token',
  'x-amz-content-sha256',
  'user-agent',
]);

function headersToRecord(headers: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** Pass the body through while counting bytes; error the stream once the cap is exceeded. */
function limitResponseBody(res: Response, maxBytes: number, onOversized: (() => void) | undefined): Response {
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          onOversized?.();
          controller.error(new Error('aws_mcp_response_too_large'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function createSigningFetch(options: SigningFetchOptions): FetchLike {
  const endpoint = new URL(AWS_MCP_ENDPOINT);
  const now = options.now ?? (() => new Date());

  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (
      url.protocol !== 'https:' ||
      url.host !== endpoint.host ||
      url.pathname !== endpoint.pathname ||
      url.search !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error('aws_mcp_signing_target_rejected');
    }

    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      // No server-initiated event stream: tell the transport this endpoint offers none.
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    }
    if (method !== 'POST' && method !== 'DELETE') throw new Error('aws_mcp_signing_method_rejected');

    let body: string | undefined;
    if (method === 'POST') {
      if (typeof init?.body !== 'string') throw new Error('aws_mcp_signing_body_rejected');
      if (Buffer.byteLength(init.body, 'utf8') > AWS_MCP_MAX_REQUEST_BODY_BYTES) {
        throw new Error('aws_mcp_request_too_large');
      }
      body = init.body;
    }

    const credentials = await options.getCredentials();
    const incoming = headersToRecord(init?.headers);
    const extraHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!MANAGED_HEADERS.has(key) && key !== 'content-type') extraHeaders[key] = value.trim();
    }
    if (body !== undefined) extraHeaders['content-type'] = (incoming['content-type'] ?? 'application/json').trim();
    const signed = signRequest({
      method,
      host: url.host,
      path: url.pathname,
      body,
      region: options.scope.region,
      service: options.scope.service,
      credentials,
      now: now(),
      extraHeaders,
    });

    const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...signed.headers };

    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(options.remainingMs())));
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const res = await options.fetchImpl(url.toString(), { method, headers, body, signal, redirect: 'error' });
    return limitResponseBody(res, AWS_MCP_MAX_UPSTREAM_BODY_BYTES, options.onOversizedResponse);
  };
}
