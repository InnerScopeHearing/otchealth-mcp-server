import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadEnv } from '../config/env.js';
import { hashToken, logger } from '../audit/logger.js';
import { isRevoked } from './revocation-store.js';
import { isValidIssuedAccessToken, issuedAgent, issuedClientId, baseUrlOf } from '../server/oauth.js';
import { agentFromDescopeToken } from './descope.js';

const env = loadEnv();

export interface AuthContext {
  caller_hash: string;
  raw_token: string;
  caller_agent: string;
  /** True when the token was issued to a Dynamic-Client-Registration (Claude Chat) connector client. */
  connector_surface: boolean;
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Extract the M365 declarative-agent static token from the request's query string.
 *
 * WHY THIS EXISTS (2026-07-25, fleet-wide MCP wiring): a Microsoft 365 declarative agent's
 * "RemoteMCPServer" runtime (ai-plugin.json schema v2.4+) supports exactly two auth modes —
 * OAuthPluginVault and None (confirmed via deep research 2026-07-25; ApiKeyPluginVault is
 * explicitly NOT supported for MCP plugins, and OAuthPluginVault's auth-config record can only be
 * created through the Teams Developer Portal UI — no Graph API or CLI path exists for it, so it's
 * not a real non-interactive option). With auth:None, Copilot's MCP runtime injects NO header of
 * any kind — the ONLY thing under our control is the static `spec.url` baked into the published
 * manifest. So the "credential" has to travel as part of that URL, and a query string is the only
 * part of a URL a JSON-RPC-over-HTTP POST reliably preserves end to end. This is a documented,
 * unrestricted pattern (no Microsoft schema rule forbids a token in spec.url) — not a workaround
 * that violates anything, just an inelegant consequence of ApiKeyPluginVault not existing for MCP.
 * Rotating a token means republishing that agent's app package (Graph POST to appCatalogs/teamsApps),
 * the same non-interactive mechanism already used to publish it in the first place.
 */
function extractQueryToken(request: FastifyRequest): string | null {
  const q = request.query as Record<string, unknown> | undefined;
  const v = q?.m365_dev_token;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Static M365 declarative-agent tokens, one per fleet lane, all following the identical
 * zero-portal-step auth:none + query-string-token pattern first proven on the developer lane
 * (2026-07-25). Kept as individually named env vars (matching this file's existing convention for
 * PERPLEXITY_CONNECTOR_TOKEN / COPILOT_AGENT_TOKEN) rather than a generic JSON blob, so each lane's
 * token can be independently rotated without touching the others. None of these widen what a lane
 * can DO — they are a second, non-interactive front door to the SAME lane identities the Hyperagent
 * "OTCHealth Gateway (<Role>)" skills already reach via OAuth client_credentials.
 */
function m365StaticAgentTokens(): Record<string, string> {
  return {
    cto: env.M365_CTO_MCP_TOKEN,
    cfo: env.M365_CFO_MCP_TOKEN,
    clo: env.M365_CLO_MCP_TOKEN,
    coo: env.M365_COO_MCP_TOKEN,
    cro: env.M365_CRO_MCP_TOKEN,
    developer: env.M365_DEVELOPER_MCP_TOKEN,
  };
}

/**
 * Validates a bearer against PERPLEXITY_CONNECTOR_TOKEN. On success returns
 * the AuthContext (with SHA256 caller hash). On failure returns null and the
 * caller is responsible for sending 401. Never logs the raw token.
 */
export async function validateBearer(authHeader: string | undefined): Promise<AuthContext | null> {
  const token = extractBearer(authHeader);
  if (!token) return null;
  if (isRevoked(token)) {
    logger.warn(
      { type: 'auth_revoked', caller_hash: hashToken(token) },
      'rejected revoked connector token',
    );
    return null;
  }
  // Accept: (1) a real issued OAuth 2.1 access token (HS256 JWT); (2) a Descope-issued RS256
  // session JWT for the clo-lane pilot (Phase 2, 2026-07-08 -- inert unless DESCOPE_PROJECT_ID
  // is configured, and gated to DESCOPE_PILOT_LANES regardless; see auth/descope.ts); (3) the
  // static connector token (back-compat, identity=OAUTH_DEFAULT_AGENT); (4) the long-lived
  // low-priv COPILOT_AGENT_TOKEN (identity='copilot-agent') for the GitHub Copilot coding
  // agents' MCP header; (5) one of the M365 declarative-agent per-lane static tokens (see
  // m365StaticAgentTokens above) for each fleet agent's own MCP runtime (see extractQueryToken's
  // header for why these travel as a query-string value wrapped into a synthetic "Bearer <token>"
  // string by requireConnectorAuth below, rather than a real Authorization header). All
  // rotate-before-launch.
  const issued = isValidIssuedAccessToken(token);
  let descopeAgent: string | null = null;
  let staticAgent: string | null = null;
  if (!issued) {
    // Only worth attempting Descope verification if the token even looks like a JWT (3 dot-
    // separated segments) -- cheap guard that avoids a pointless JWKS-cache lookup for the
    // static-token paths below, which are opaque random strings, not JWTs.
    if (token.split('.').length === 3) {
      descopeAgent = await agentFromDescopeToken(token);
    }
    if (!descopeAgent) {
      if (safeEqual(token, env.PERPLEXITY_CONNECTOR_TOKEN)) {
        staticAgent = env.OAUTH_DEFAULT_AGENT || '';
      } else if (env.COPILOT_AGENT_TOKEN && env.COPILOT_AGENT_TOKEN.length >= 32 && safeEqual(token, env.COPILOT_AGENT_TOKEN)) {
        // Deliberately low-privilege: 'copilot-agent' is NOT cfo/clo/clo-personal (no privileged RAG)
        // and NOT cto (no GitHub writes / builds). It gets reads, commons RAG, llm_azure, guardrails.
        staticAgent = 'copilot-agent';
      } else {
        const m365Hit = Object.entries(m365StaticAgentTokens()).find(
          ([, v]) => v && v.length >= 32 && safeEqual(token, v),
        );
        if (m365Hit) {
          staticAgent = m365Hit[0];
        } else {
          return null;
        }
      }
    }
  }
  const caller_agent = issued ? (issuedAgent(token) || '') : (descopeAgent || staticAgent || '');
  const clientId = issued ? issuedClientId(token) : null;
  // Connector clients: DCR public clients (dcr_) OR manually-registered confidential connector clients
  // (occ_ = OTCHealth Connector Client) entered in Claude's Advanced settings to bypass the DCR tool-delivery
  // bug (modelcontextprotocol#1675). Both get the curated, spec-bare connector surface.
  const connector_surface = Boolean(clientId && (clientId.startsWith('dcr_') || clientId.startsWith('occ_')));
  return { caller_hash: hashToken(token), raw_token: token, caller_agent, connector_surface };
}

export function validateAdminToken(authHeader: string | undefined): boolean {
  const token = extractBearer(authHeader);
  if (!token) return false;
  return safeEqual(token, env.ADMIN_REVOKE_TOKEN);
}

/** Fastify pre-handler enforcing connector-bearer auth on a route. */
export async function requireConnectorAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | undefined> {
  let ctx = await validateBearer(request.headers['authorization']);
  if (!ctx) {
    // No Authorization header matched -- try the M365 declarative-agent query-string token (see
    // extractQueryToken's doc comment). Wrapping it as a synthetic "Bearer <token>" string reuses
    // validateBearer's existing safeEqual/timing-safe comparison and revocation check verbatim,
    // rather than duplicating that logic for a second token source.
    const queryToken = extractQueryToken(request);
    if (queryToken) ctx = await validateBearer(`Bearer ${queryToken}`);
  }
  if (!ctx) {
    logger.warn(
      {
        type: 'auth_rejected',
        route: request.routeOptions?.url ?? request.url,
        ip: request.ip,
      },
      'connector auth rejected',
    );
    // RFC 9728: point spec-compliant MCP clients at the protected-resource metadata endpoint so they
    // can discover the authorization server instead of failing silently on a bare 401. Uses the same
    // base-url derivation as the OAuth metadata routes (oauth.ts's baseUrlOf), so this always names
    // the correct host whether PUBLIC_BASE_URL is set or derived from the request.
    reply.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${baseUrlOf(request)}/.well-known/oauth-protected-resource"`,
    );
    await reply.code(401).send({
      error: 'unauthorized',
      message:
        'Missing or invalid bearer token. Provide Authorization: Bearer <PERPLEXITY_CONNECTOR_TOKEN>.',
    });
    return undefined;
  }
  (request as FastifyRequest & { authContext?: AuthContext }).authContext = ctx;
  return ctx;
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}
