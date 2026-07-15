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
  registerStatelessClient,
  parseStatelessClient,
} from '../auth/oauth-tokens.js';
import { EXEC_RING } from '../tools/kb/search-privileged.js';

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

// Claude.ai custom-connector OAuth callback(s). Allowed as redirect targets so a Claude Chat connector
// can complete the authorization-code + PKCE flow. (The connector delivers the code to Claude, so the
// redirect allow-list + PKCE are what protect the flow.)
const CLAUDE_CALLBACKS = new Set<string>([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

interface ResolvedAnyClient { secret: string; agent: string; isPublic: boolean; redirectUris?: string[]; }
/** Resolve confidential (static/OAUTH_CLIENTS) clients OR stateless-DCR PUBLIC clients (dcr_...). */
function resolveAnyClient(clientId: string): ResolvedAnyClient | null {
  const rc = resolveClient(clientId);
  if (rc) return { secret: rc.secret, agent: rc.agent, isPublic: false };
  if (env.OAUTH_TOKEN_SIGNING_SECRET) {
    const d = parseStatelessClient(clientId, env.OAUTH_TOKEN_SIGNING_SECRET);
    if (d) return { secret: '', agent: (d.agent || '').toLowerCase(), isPublic: true, redirectUris: d.redirectUris };
  }
  return null;
}

/** Exported so auth/bearer.ts can point a 401's WWW-Authenticate header at the same base URL the
 * OAuth metadata endpoints use (RFC 9728 protected-resource discovery) without re-deriving it. */
export function baseUrlOf(req: { protocol: string; hostname: string }): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.hostname}`;
}

function allowedRedirect(uri: string): boolean {
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  const list = (env.OAUTH_REDIRECT_URIS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // If no allow-list is configured, accept any https redirect (still gated by client_secret + PKCE).
  if (list.length === 0) return /^https:\/\//i.test(uri);
  return list.includes(uri);
}

// SECURITY-CRITICAL (Phase 5/6 connector-ring closure, 2026-07-15, Part 6 -- the actual fix): there is
// intentionally NO mapping from a connector's client_name to a ring lane anymore. A self-registered
// PUBLIC (DCR) client has NO identity proof -- it presents no pre-shared secret, supplies its own PKCE
// verifier, and the auth code is readable off the /authorize 302 Location header -- so anyone can
// complete its flow. Deriving a privileged lane from a caller-CHOSEN name was therefore a self-mint
// hole: naming a connector "Finance Tracker" used to bind the privileged cfo lane. Parts 2 + 5 hardened
// that name->lane inference (fallback off 'clo', word-boundary matching) but could not make it SAFE,
// because the name is attacker-controlled by construction. Part 6 removes the inference entirely: every
// public DCR client is hard-bound to the non-privileged 'external-read' lane at /register below. A
// privileged lane is reachable ONLY through a CONFIDENTIAL client (resolveClient / OAUTH_CLIENTS /
// occ_) whose secret Matt provisioned in config and which IS secret-checked at the token endpoint. The
// former DCR_LANES table, escapeRegExp, DCR_LANE_MATCHERS, and laneFromClientName existed ONLY to do
// that unsafe mapping and were deleted with it.

/** True if `agent` (a resolved lane) is a privileged EXEC_RING lane. Exported so the startup guard's
 * CONDITION is unit-testable without capturing logger output -- mirrors this repo's "extract the pure
 * predicate, export it for hermetic tests" convention (isLaneAllowed / isShipLane / memoryWriteRefusal). */
export function isPrivilegedDefaultAgent(agent: string | undefined | null): boolean {
  return (EXEC_RING as readonly string[]).includes((agent || '').toLowerCase());
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  // STARTUP GUARD (Phase 6 reviewer nit): OAUTH_DEFAULT_AGENT is the lane bound to the static
  // PERPLEXITY_CONNECTOR_TOKEN and to the single confidential OAUTH_CLIENT_ID connection. Those are
  // broadly-held, long-lived credentials, so if OAUTH_DEFAULT_AGENT is ever set to a privileged
  // EXEC_RING lane, every static-token caller would silently carry MNPI/attorney-privileged access.
  // Production uses 'cto' (NOT in EXEC_RING, so this never fires there). This is a loud warning, not a
  // hard fail: a deliberately secret-provisioned confidential exec client is still possible, but a
  // misconfiguration is impossible to miss in the logs. (Warn-only, not a clamp, so it cannot break a
  // legitimately-provisioned confidential exec connection.)
  if (isPrivilegedDefaultAgent(env.OAUTH_DEFAULT_AGENT)) {
    logger.warn(
      { type: 'oauth_default_agent_privileged', agent: (env.OAUTH_DEFAULT_AGENT || '').toLowerCase() },
      'OAUTH_DEFAULT_AGENT is set to a privileged EXEC_RING lane; static-token callers would get privileged access. Set it to a non-privileged lane (e.g. cto or external-read) unless this is a deliberate, secret-provisioned confidential exec client.',
    );
  }

  // ── RFC 8414: Authorization Server Metadata ────────────────────────────────
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const baseUrl = baseUrlOf(req);
    return reply.send({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/register`,
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

  // ── RFC 7591: Dynamic Client Registration (PUBLIC, PKCE-only, external-read ONLY) ───
  // Lets a Claude.ai custom connector self-register with no pre-shared secret. The issued client_id is
  // a stateless HMAC-signed blob bound to the non-privileged 'external-read' lane (see below) and the
  // Claude callback. No storage; survives cutovers. Redirect_uris are restricted to the Claude callback.
  app.post('/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!oauthConfigured()) return reply.status(404).send({ error: 'not_found' });
    const body = (typeof req.body === 'string' ? {} : (req.body ?? {})) as Record<string, unknown>;
    const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string') : [];
    if (uris.length === 0 || !uris.every((u) => allowedRedirect(u))) {
      return reply.status(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be the Claude connector callback' });
    }
    // SECURITY-CRITICAL (Phase 6): a self-registered PUBLIC client has NO identity proof (no pre-shared
    // secret; PKCE is self-supplied; the auth code is readable off the /authorize 302 redirect), so it
    // can ONLY ever bind the non-privileged 'external-read' lane -- REGARDLESS of what the caller names
    // the connector. The client_name is deliberately ignored here: deriving a privileged lane from an
    // attacker-controlled name was the self-mint hole. A privileged lane requires a CONFIDENTIAL client
    // (OAUTH_CLIENTS / OAUTH_CLIENT_ID / occ_) whose secret Matt provisioned and which is secret-checked
    // at the token endpoint.
    const agent = 'external-read';
    const clientId = registerStatelessClient({ agent, redirectUris: uris }, env.OAUTH_TOKEN_SIGNING_SECRET);
    reply.header('Cache-Control', 'no-store');
    logger.info({ type: 'oauth_register', agent }, 'issued stateless DCR client (external-read lane)');
    return reply.status(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    });
  });

  // ── Authorization endpoint ─────────────────────────────────────────────────
  // Strict per-route rate limit (overrides the generous global default in server/index.ts): this
  // is an unauthenticated brute-force surface, so cap it hard per client IP.
  app.get('/oauth/authorize', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = q;

    if (response_type !== 'code') {
      return reply.status(400).send({ error: 'unsupported_response_type' });
    }
    if (!redirect_uri || !allowedRedirect(redirect_uri)) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'redirect_uri not allowed' });
    }

    if (oauthConfigured()) {
      const ac = client_id ? resolveAnyClient(client_id) : null;
      if (!ac) {
        return reply.status(400).send({ error: 'invalid_client' });
      }
      // A public (DCR) client may only redirect to a URI it registered.
      if (ac.isPublic && ac.redirectUris && !ac.redirectUris.includes(redirect_uri)) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'redirect_uri not registered for this client' });
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

    const code = await createAuthCode({
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
  // Strict per-route rate limit: the token endpoint mints access tokens (auth-code exchange and
  // client_credentials), so it is the highest-value brute-force target on the gateway.
  app.post('/oauth/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
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
      const rc = resolveAnyClient(claims.sub);
      if (!rc) return reply.status(401).send({ error: 'invalid_client' });
      if (!rc.isPublic && client_secret !== rc.secret) return reply.status(401).send({ error: 'invalid_client' });
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

    const rec = await consumeAuthCode(code);
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
      const rc = resolveAnyClient(rec.clientId);
      if (!rc) return reply.status(401).send({ error: 'invalid_client' });
      // Confidential clients must present their secret; PUBLIC (DCR) clients rely on PKCE alone.
      if (!rc.isPublic && client_secret !== rc.secret) {
        return reply.status(401).send({ error: 'invalid_client', error_description: 'client_secret required' });
      }
      // Mandatory PKCE verification (all clients).
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

/** The client_id (sub) embedded in a valid issued access token, or null. DCR connector clients start with 'dcr_'. */
export function issuedClientId(token: string): string | null {
  if (!env.OAUTH_TOKEN_SIGNING_SECRET) return null;
  const claims = verifyToken(token, env.OAUTH_TOKEN_SIGNING_SECRET);
  if (!claims || claims.typ !== 'access') return null;
  return claims.sub || null;
}

/** The agent identity embedded in a valid issued access token (per-agent OAuth client), or null. */
export function issuedAgent(token: string): string | null {
  if (!env.OAUTH_TOKEN_SIGNING_SECRET) return null;
  const claims = verifyToken(token, env.OAUTH_TOKEN_SIGNING_SECRET);
  if (!claims || claims.typ !== 'access') return null;
  return claims.agent || '';
}
