import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How a request authenticated, recorded once by auth/bearer.ts (validateBearer).
 *
 *   oauth        a gateway-issued OAuth 2.1 access token (the claude.ai / Claude Chat connector path)
 *   descope      a Descope-issued session JWT (clo-lane pilot)
 *   connector    the static PERPLEXITY_CONNECTOR_TOKEN
 *   copilot      the static COPILOT_AGENT_TOKEN
 *   copilot-dev  the static COPILOT_DEV_AGENT_TOKEN
 *   eval         the static EVAL_AGENT_TOKEN
 *   m365         an M365 declarative-agent static per-lane token (it travels in a published manifest URL)
 *   codex        a Codex static per-seat token
 *
 * A tool that must serve interactive OAuth sessions only (the AWS MCP bridge) accepts 'oauth' and
 * nothing else. A request whose code path never recorded a kind has none, and is refused the same way.
 */
export type AuthKind = 'oauth' | 'descope' | 'connector' | 'copilot' | 'copilot-dev' | 'eval' | 'm365' | 'codex';

/**
 * Which OAuth grant issued a gateway access token. The token endpoint (server/oauth.ts) stamps it into
 * the signed token as the `gty` claim, and auth/bearer.ts reads it back for an 'oauth' request.
 *
 *   authorization_code  an interactive sign-in (browser consent plus PKCE): the claude.ai connector flow
 *   refresh_token       a refresh of an authorization_code session (only those sessions hold a refresh token)
 *   client_credentials  a machine credential (client id plus secret) with no human sign-in
 *
 * A token minted before grant tracking existed carries no grant. A tool that must serve interactive
 * sessions only (the AWS MCP bridge) accepts the first two and refuses a client_credentials token and
 * a token that records no grant.
 */
export const OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials'] as const;
export type OAuthGrantType = (typeof OAUTH_GRANT_TYPES)[number];

/** True for one of the three grant names above (a claim read from a token is never trusted as typed). */
export function isOAuthGrantType(value: unknown): value is OAuthGrantType {
  return typeof value === 'string' && (OAUTH_GRANT_TYPES as readonly string[]).includes(value);
}

export interface RequestContext {
  callerHash: string;
  correlationId: string;
  callerAgent: string;
  /** True for Claude Chat (DCR) connector requests -> advertise a curated toolset, not the full catalog. */
  connectorSurface?: boolean;
  /**
   * True for M365 declarative-agent static-token requests (see auth/bearer.ts's m365_static_auth).
   * Used by tools/registry.ts to skip JIT result-offloading for these callers -- see bearer.ts's
   * AuthContext.m365_static_auth doc comment for why.
   */
  m365StaticAuth?: boolean;
  /** How the request authenticated (see AuthKind). Unset when the code path did not record it. */
  authKind?: AuthKind;
  /** For an 'oauth' request, the grant that issued its access token (see OAuthGrantType). Unset when the token records none. */
  authGrant?: OAuthGrantType;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentCallerHash(): string {
  return requestContext.getStore()?.callerHash ?? 'unknown';
}

export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? 'unknown';
}

/** The agent identity derived from the caller's OAuth token (per-agent client), or '' if unknown. */
export function currentCallerAgent(): string {
  return requestContext.getStore()?.callerAgent ?? '';
}

/** True when the current request is a Claude Chat (DCR) connector — gets the curated toolset. */
export function isConnectorSurface(): boolean {
  return requestContext.getStore()?.connectorSurface === true;
}

/** True when the current request authenticated via an M365 declarative-agent static token. */
export function isM365StaticAuth(): boolean {
  return requestContext.getStore()?.m365StaticAuth === true;
}

/** How the current request authenticated, or undefined when no kind was recorded (treat as not OAuth). */
export function currentAuthKind(): AuthKind | undefined {
  return requestContext.getStore()?.authKind;
}
