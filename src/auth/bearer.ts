import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadEnv } from '../config/env.js';
import { hashToken, logger } from '../audit/logger.js';
import { isRevoked } from './revocation-store.js';
import { isValidIssuedAccessToken, issuedAgent, issuedClientId } from '../server/oauth.js';
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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
  // agents' MCP header. All rotate-before-launch.
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
        return null;
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
  const ctx = await validateBearer(request.headers['authorization']);
  if (!ctx) {
    logger.warn(
      {
        type: 'auth_rejected',
        route: request.routeOptions?.url ?? request.url,
        ip: request.ip,
      },
      'connector auth rejected',
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
