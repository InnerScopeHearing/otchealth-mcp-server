import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Strips the query string from a URL before it is used in ANY log record.
 *
 * WHY THIS EXISTS (2026-08-18, HIGH security finding, M365 static-token-in-URL): the gateway
 * accepts several static per-lane credentials as a `?<param>=<token>` query parameter on `/mcp`
 * (see auth/bearer.ts's extractQueryToken -- a genuine platform constraint, not a choice, for the
 * M365 declarative-agent RemoteMCPServer runtime) and OAuth callback routes carry `?code=&state=`.
 * A URL is the one thing every layer of the stack -- proxies, CDNs, this gateway's own structured
 * logs, crash reports, browser history -- tends to record verbatim. This gateway cannot control
 * the layers outside its own process, but it fully controls whether ITS OWN logs echo the query
 * string back out. `pathOnly` removes it before the URL ever reaches a log call.
 */
export function pathOnly(url: string): string {
  const qIndex = url.indexOf('?');
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

/**
 * Build the structured payload for the per-response 'http_response' debug log line.
 *
 * WHY THIS IS A SEPARATE, EXPORTED FUNCTION (2026-08-18): mirrors auth/bearer.ts's
 * authRejectionLogFields, split out for the identical reason documented there -- pino writes via
 * sonic-boom directly to the fd, bypassing process.stdout.write, so a stdout spy cannot observe
 * what actually got logged. The only test-observable surface is the payload VALUE handed to the
 * logger call, so that value has to live in its own function a test can call directly.
 *
 * Before this existed, index.ts's onResponse hook logged `url: request.url` verbatim -- the FULL
 * request URL, including any query string -- at logger.debug on every single response, for every
 * route, unconditionally. pino's field-path `redact` config (audit/logger.ts) only redacts whole
 * VALUES matching a known field path; it cannot see inside a string like
 * "/mcp?m365_dev_token=abc123" and strip just the secret substring, so that existing redaction
 * never touched this field. LOG_LEVEL defaults to 'info' (this line is silent today), but the
 * payload itself was still wrong: raising LOG_LEVEL to 'debug' for any reason -- a local debug
 * session, a future incident investigation, an operator following a runbook -- would start writing
 * the M365 static per-lane bearer tokens, and any other query-string secret (an OAuth
 * authorization `code`, a `state` value), straight into whatever ships these logs (Datadog,
 * CloudWatch, stdout). Path-only logging carries the same operational signal (route, method,
 * status, latency, caller IP) with none of that risk, so there is no tradeoff being made here.
 */
export function responseLogFields(
  request: FastifyRequest,
  reply: FastifyReply,
  latencyMs: number,
): Record<string, unknown> {
  return {
    type: 'http_response',
    method: request.method,
    url: pathOnly(request.url),
    status: reply.statusCode,
    latency_ms: Math.round(latencyMs),
    ip: request.ip,
  };
}
