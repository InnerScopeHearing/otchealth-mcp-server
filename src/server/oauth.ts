/**
 * OAuth 2.1 endpoints for MCP server authentication.
 *
 * Real OAuth 2.1 (authorization-code + mandatory PKCE S256, confidential client):
 *   1. Client (e.g. Hyperagent) discovers endpoints via the well-known metadata.
 *   2. GET /oauth/authorize?client_id&redirect_uri&response_type=code&state&code_challenge&code_challenge_method=S256
 *      validates client_id + redirect_uri (allow-list) and auto-issues a short-lived code (no human
 *      login surface; the security is confidential-client secret at the token endpoint + PKCE + the
 *      redirect allow-list).
 *   3. POST /oauth/token exchanges the code for a real expiring HS256 JWT access_token (+ refresh_token),
 *      requiring the client_secret (client_secret_post) AND the PKCE code_verifier.
 *   4. The access_token is presented as Authorization: Bearer on POST /mcp and validated in auth/bearer.ts.
 *
 * Config (config/env.ts):
 *   OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_TOKEN_SIGNING_SECRET, OAUTH_REDIRECT_URIS (csv),
 *   PUBLIC_BASE_URL (optional override for metadata URLs).
 *
 * BACK-COMPAT: when OAuth env is not configured, the legacy stub behavior is preserved
 * (client_id == PERPLEXITY_CONNECTOR_TOKEN, token endpoint returns the static connector token) so
 * existing CLI/curl callers keep working during the cutover.
 */

import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import {
  createAuthCode,
  consumeAuthCode,
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
  verifyPkceS256,
} from '../auth/oauth-tokens.js';

const env = loadEnv();

/** OAuth 2.1 is "armed" only when a client id + signing secret are configured. */
function oauthConfigured(): boolean {
  return Boolean(env.OAUTH_TOKEN_SIGNING_SECRET && (env.OAUTH_CLIENT_ID || env.OAUTH_CLIENTS));
}

interface ResolvedClient { secret: string; agent: string; }
/** Resolve a client_id to its secret + agent lane: per-agent OAUTH_CLIENTS first, then the single client. */
function resolveClient(clientId: string): ResolvedClient | null {
  if (env.OAUTH_CLIENTS) {
    try {
      const arr = JSON.parse(env.OAUTH_CLIENTS) as Array<{ client_id: string; secret: string; agent?: string }>;
      const m = arr.find((c) => c && c.client_id === clientId);
      if (m) return { secret: m.secret, agent: (m.agent || '').toLowerCase() };
    } catch { /* ignore malformed OAUTH_CLIENTS */ }
  }
  if (env.OAUTH_CLIENT_ID && clientId === env.OAUTH_CLIENT_ID) {
    return { secret: env.OAUTH_CLIENT_SECRET, agent: (env.OAUTH_DEFAULT_AGENT || '').toLowerCase() };
  }
  return null;
}

function baseUrlOf(req: { protocol: string; hostname: string }): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.hostname}`;
}

function allowedRedirect(uri: string): boolean {
  const list = (env.OAUTH_REDIRECT_URIS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // If no allow-list is configured, accept any https redirect (still gated by client_secret + PKCE).
  if (list.length === 0) return /^https:\/\//i.test(uri);
  return list.includes(uri);
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  // ── RFC 8414: Authorization Server Metadata ────────────────────────────────
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const baseUrl = baseUrlOf(req);
    return reply.send({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: ['mcp'],
    });
  });

  // ── RFC 9728: Protected Resource Metadata (some MCP clients probe this) ─────
  app.get('/.well-known/oauth-protected-resource', async (req, reply) => {
    const baseUrl = baseUrlOf(req);
    return reply.send({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
  });

  // ── Authorization endpoint ─────────────────────────────────────────────────
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = q;

    if (response_type !== 'code') {
      return reply.status(400).send({ error: 'unsupported_response_type' });
    }
    if (!redirect_uri || !allowedRedirect(redirect_uri)) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'redirect_uri not allowed' });
    }

    if (oauthConfigured()) {
      if (!client_id || !resolveClient(client_id)) {
        return reply.status(400).send({ error: 'invalid_client' });
      }
    } else if (!client_id || client_id !== env.PERPLEXITY_CONNECTOR_TOKEN) {
      return reply.status(400).send({ error: 'invalid_client' });
    }

    // OAuth 2.1: PKCE is mandatory and only S256 is accepted.
    if (oauthConfigured()) {
      if (!code_challenge || code_challenge_method !== 'S256') {
        return reply
          .status(400)
          .send({ error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required' });
      }
    }

    const code = createAuthCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      scope: 'mcp',
      codeChallenge: code_challenge ?? '',
      codeChallengeMethod: 'S256',
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    logger.info({ type: 'oauth_authorize', redirect_uri }, 'issued auth code');
    return reply.status(302).redirect(url.toString());
  });

  // ── Token endpoint ─────────────────────────────────────────────────────────
  app.post('/oauth/token', async (req, reply) => {
    const body =
      typeof req.body === 'string'
        ? (Object.fromEntries(new URLSearchParams(req.body)) as Record<string, string>)
        : ((req.body ?? {}) as Record<string, string>);

    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = body;
    const baseUrl = baseUrlOf(req);

    // ----- client_credentials grant (machine-to-machine; per-agent trusted lanes) -----
    // Lets a trusted engine (e.g. the CFO/CLO agent on Claude Code) obtain a short-lived access
    // token carrying its agent identity, with NO browser flow. Confidential: client_id+client_secret
    // must match an OAUTH_CLIENTS entry. The issued token's agent lane drives governance + ring gates.
    if (grant_type === 'client_credentials') {
      if (!oauthConfigured()) return reply.status(400).send({ error: 'unsupported_grant_type' });
      const rc = client_id ? resolveClient(client_id) : null;
      if (!rc || client_secret !== rc.secret) return reply.status(401).send({ error: 'invalid_client' });
      reply.header('Cache-Control', 'no-store');
      logger.info({ type: 'oauth_client_credentials', agent: rc.agent }, 'issued client_credentials access token');
      return reply.send({
        access_token: issueAccessToken(client_id, 'mcp', env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, rc.agent),
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      });
    }

    // ----- refresh_token grant -----
    if (grant_type === 'refresh_token') {
      if (!oauthConfigured()) return reply.status(400).send({ error: 'unsupported_grant_type' });
      const claims = refresh_token ? verifyToken(refresh_token, env.OAUTH_TOKEN_SIGNING_SECRET) : null;
      if (!claims || claims.typ !== 'refresh') {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'invalid refresh_token' });
      }
      const rc = resolveClient(claims.sub);
      if (!rc || client_secret !== rc.secret) return reply.status(401).send({ error: 'invalid_client' });
      reply.header('Cache-Control', 'no-store');
      return reply.send({
        access_token: issueAccessToken(claims.sub, claims.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, rc.agent),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: issueRefreshToken(claims.sub, claims.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, rc.agent),
        scope: claims.scope,
      });
    }

    // ----- authorization_code grant -----
    if (grant_type !== 'authorization_code') {
      return reply.status(400).send({ error: 'unsupported_grant_type' });
    }
    if (!code) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'code required' });
    }

    const rec = consumeAuthCode(code);
    if (!rec) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired or invalid' });
    }
    if (redirect_uri && redirect_uri !== rec.redirectUri) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    if (client_id && client_id !== rec.clientId) {
      return reply.status(400).send({ error: 'invalid_client' });
    }

    if (oauthConfigured()) {
      // Confidential client: require the matching secret (per-agent or single).
      const rc = resolveClient(rec.clientId);
      if (!rc || client_secret !== rc.secret) {
        return reply.status(401).send({ error: 'invalid_client', error_description: 'client_secret required' });
      }
      // Mandatory PKCE verification.
      if (!rec.codeChallenge || !code_verifier || !verifyPkceS256(code_verifier, rec.codeChallenge)) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      reply.header('Cache-Control', 'no-store');
      return reply.send({
        access_token: issueAccessToken(rec.clientId, rec.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, rc.agent),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: issueRefreshToken(rec.clientId, rec.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, rc.agent),
        scope: rec.scope,
      });
    }

    // ----- LEGACY fallback (OAuth not configured): preserve old stub behavior -----
    if (rec.codeChallenge) {
      if (!code_verifier || !verifyPkceS256(code_verifier, rec.codeChallenge)) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'code_verifier invalid' });
      }
    }
    reply.header('Cache-Control', 'no-store');
    return reply.send({
      access_token: env.PERPLEXITY_CONNECTOR_TOKEN,
      token_type: 'Bearer',
      expires_in: 86400 * 365,
    });
  });
}

/** Exposed for auth/bearer.ts: is a presented token a valid issued OAuth access token? */
export function isValidIssuedAccessToken(token: string): boolean {
  if (!env.OAUTH_TOKEN_SIGNING_SECRET) return false;
  const claims = verifyToken(token, env.OAUTH_TOKEN_SIGNING_SECRET);
  return Boolean(claims && claims.typ === 'access');
}

/** The agent identity embedded in a valid issued access token (per-agent OAuth client), or null. */
export function issuedAgent(token: string): string | null {
  if (!env.OAUTH_TOKEN_SIGNING_SECRET) return null;
  const claims = verifyToken(token, env.OAUTH_TOKEN_SIGNING_SECRET);
  if (!claims || claims.typ !== 'access') return null;
  return claims.agent || '';
}
