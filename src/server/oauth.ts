/**
 * OAuth 2.1 endpoints for MCP authorization (per the MCP 2025-06-18 spec).
 *
 * The MCP server is an OAuth 2.1 RESOURCE SERVER and hosts its (minimal)
 * authorization server. Implements the spec MUSTs:
 *   - RFC 9728 Protected Resource Metadata  (/.well-known/oauth-protected-resource)
 *   - WWW-Authenticate on 401               (auth/bearer.ts)
 *   - RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server)
 *   - OAuth 2.1 authorization_code + PKCE(S256) (/oauth/authorize, /oauth/token)
 * and the SHOULD:
 *   - RFC 7591 Dynamic Client Registration    (/register)
 *
 * SECURITY MODEL (public, keys-to-the-kingdom; hardened per the 2026-06-13 review):
 *   - A client MUST register first (DCR) to obtain a client_id bound to its exact
 *     redirect_uris. The browser flow is only for registered clients; bearer-direct
 *     clients (Perplexity / Claude Code) never use it.
 *   - OPEN registration only hands out a client_id (no access). The ACCESS gate is
 *     the resource-owner CONSENT at POST /oauth/authorize (constant-time check of the
 *     consent secret). No request-controlled value is reflected into the consent HTML,
 *     and the post-consent redirect target is the REGISTERED redirect_uri read from
 *     the server-side store (never raw request input), re-validated to https/localhost.
 *   - Issuer / metadata / WWW-Authenticate are derived from the trusted
 *     PUBLIC_BASE_URL, never the (spoofable) request Host header.
 *   - PKCE S256 is MANDATORY; `plain` is not offered.
 *   - The token endpoint mints a PER-CLIENT, server-side-expiring, revocable access
 *     token (auth/oauth-token-store.ts); the static connector bearer is never handed out.
 *   - Open endpoints are size-bounded and per-IP rate-limited.
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { mintAccessToken, sweepAccessTokens } from '../auth/oauth-token-store.js';

const env = loadEnv();

const MAX_CLIENTS = 1000;
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_AUTHZ_REQUESTS = 2000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RL_WINDOW_MS = 60_000;

const clients = new Map<string, { redirectUris: string[]; createdAt: number }>();

const authzRequests = new Map<
  string,
  { clientId: string; redirectUri: string; codeChallenge: string; state?: string; expiresAt: number }
>();

const authCodes = new Map<
  string,
  { clientId: string; redirectUri: string; codeChallenge: string; expiresAt: number }
>();

// Per-IP fixed-window rate limiter (no external dependency).
const rl = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string, max: number): boolean {
  const now = Date.now();
  const e = rl.get(ip);
  if (!e || e.resetAt < now) {
    rl.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return false;
  }
  e.count += 1;
  return e.count > max;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authzRequests) if (v.expiresAt < now) authzRequests.delete(k);
  for (const [k, v] of authCodes) if (v.expiresAt < now) authCodes.delete(k);
  for (const [k, v] of clients) if (v.createdAt + CLIENT_TTL_MS < now) clients.delete(k);
  for (const [k, v] of rl) if (v.resetAt < now) rl.delete(k);
  sweepAccessTokens();
}, 60_000).unref?.();

function generateId(): string {
  return randomBytes(32).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PKCE S256 only. */
function verifyS256(verifier: string, challenge: string): boolean {
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

function consentSecret(): string {
  return env.OAUTH_CONSENT_SECRET || env.ADMIN_REVOKE_TOKEN;
}

/** Trusted, stable base URL (never request-derived). */
function baseUrl(): string {
  return env.PUBLIC_BASE_URL;
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Resolve a registered client + return its EXACT registered redirect_uri. */
function resolveRegisteredRedirect(
  clientId: string | undefined,
  requestedRedirect: string | undefined,
): { ok: true; redirectUri: string } | { ok: false; error: string; description: string } {
  if (!clientId) return { ok: false, error: 'invalid_client', description: 'client_id required' };
  if (!requestedRedirect) return { ok: false, error: 'invalid_request', description: 'redirect_uri required' };
  const registered = clients.get(clientId);
  if (!registered) {
    return { ok: false, error: 'invalid_client', description: 'unknown client_id (register via /register first)' };
  }
  const match = registered.redirectUris.find((u) => u === requestedRedirect);
  if (!match || !isValidRedirectUri(match)) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri not registered for this client' };
  }
  return { ok: true, redirectUri: match };
}

/** Consent page. NO request-controlled value is interpolated into this HTML. */
function renderConsentPage(requestId: string, withError = false): string {
  const err = withError ? '<p style="color:#f87171;font-size:.9rem">Incorrect consent secret, try again.</p>' : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTCHealth MCP - Authorize</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1e293b;padding:2rem;border-radius:12px;max-width:420px;width:90%;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  h1{font-size:1.25rem;margin:0 0 .5rem} p{color:#94a3b8;font-size:.9rem;line-height:1.4}
  input[type=password]{width:100%;padding:.7rem;margin:.75rem 0;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;box-sizing:border-box}
  button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#0d9488;color:#fff;font-weight:600;cursor:pointer}
</style></head>
<body><form class="card" method="POST" action="/oauth/authorize">
  <h1>Authorize MCP connector</h1>
  ${err}
  <p>A connector is requesting access to the OTCHealth fleet gateway. Enter the operator consent secret to approve. Only approve a connection you started.</p>
  <input type="hidden" name="request_id" value="${requestId}">
  <input type="password" name="consent_secret" placeholder="Consent secret" autocomplete="off" autofocus required>
  <button type="submit">Approve</button>
</form></body></html>`;
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  // ---- RFC 8414: Authorization Server Metadata ----
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    const b = baseUrl();
    return reply.send({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  // ---- RFC 9728: Protected Resource Metadata (MUST) ----
  const prm = (): Record<string, unknown> => {
    const b = baseUrl();
    return { resource: b, authorization_servers: [b], bearer_methods_supported: ['header'], resource_documentation: `${b}/health` };
  };
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => reply.send(prm()));
  app.get('/.well-known/oauth-protected-resource/mcp', async (_req, reply) => reply.send(prm()));

  // ---- RFC 7591: Dynamic Client Registration (SHOULD) ----
  app.post('/register', async (req, reply) => {
    if (rateLimited(req.ip, 20)) return reply.status(429).send({ error: 'rate_limited' });
    const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) as Record<string, unknown> | undefined;
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? (body!.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
    if (redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(isValidRedirectUri)) {
      return reply.status(400).send({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be 1-10 https (or localhost) URIs',
      });
    }
    // Bound the store: evict expired, then the oldest, before inserting.
    if (clients.size >= MAX_CLIENTS) {
      const now = Date.now();
      for (const [k, v] of clients) if (v.createdAt + CLIENT_TTL_MS < now) clients.delete(k);
      while (clients.size >= MAX_CLIENTS) {
        let oldestKey: string | undefined;
        let oldest = Infinity;
        for (const [k, v] of clients) if (v.createdAt < oldest) { oldest = v.createdAt; oldestKey = k; }
        if (oldestKey === undefined) break;
        clients.delete(oldestKey);
      }
    }
    const clientId = `mcp-${generateId()}`;
    clients.set(clientId, { redirectUris, createdAt: Date.now() });
    logger.info({ type: 'oauth_client_registered', redirect_uris: redirectUris.length }, 'dcr client registered');
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // ---- Authorization endpoint: GET stashes the request + shows the consent screen ----
  app.get('/oauth/authorize', async (req, reply) => {
    if (rateLimited(req.ip, 30)) return reply.status(429).type('text/plain').send('rate_limited');
    const q = req.query as Record<string, string>;
    if (q.response_type !== 'code') {
      return reply.status(400).type('text/plain').send('unsupported_response_type (expected code)');
    }
    // PKCE S256 mandatory (OAuth 2.1).
    if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256') {
      return reply.status(400).type('text/plain').send('invalid_request: PKCE code_challenge with method S256 is required');
    }
    const resolved = resolveRegisteredRedirect(q.client_id, q.redirect_uri);
    if (!resolved.ok) {
      return reply.status(400).type('text/plain').send(`${resolved.error}: ${resolved.description}`);
    }
    if (authzRequests.size >= MAX_AUTHZ_REQUESTS) {
      // Drop the soonest-to-expire pending request to stay bounded.
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [k, v] of authzRequests) if (v.expiresAt < oldest) { oldest = v.expiresAt; oldestKey = k; }
      if (oldestKey) authzRequests.delete(oldestKey);
    }
    const requestId = generateId();
    authzRequests.set(requestId, {
      clientId: q.client_id,
      redirectUri: resolved.redirectUri,
      codeChallenge: q.code_challenge,
      state: q.state,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return reply.status(200).type('text/html').send(renderConsentPage(requestId));
  });

  // ---- Authorization endpoint: POST verifies consent + issues the code ----
  app.post('/oauth/authorize', async (req, reply) => {
    if (rateLimited(req.ip, 10)) return reply.status(429).type('text/plain').send('rate_limited');
    const body =
      (typeof req.body === 'string'
        ? Object.fromEntries(new URLSearchParams(req.body))
        : (req.body as Record<string, string>)) ?? {};
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const consent = typeof body.consent_secret === 'string' ? body.consent_secret : '';

    const pending = authzRequests.get(requestId);
    if (!pending || pending.expiresAt < Date.now()) {
      if (pending) authzRequests.delete(requestId);
      return reply.status(400).type('text/plain').send('invalid_request: authorization request expired, restart the flow');
    }
    if (!consent || !safeEqual(consent, consentSecret())) {
      logger.warn({ type: 'oauth_consent_rejected', ip: req.ip }, 'oauth consent secret rejected');
      return reply.status(401).type('text/html').send(renderConsentPage(requestId, true));
    }

    authzRequests.delete(requestId); // one-time consume

    if (!isValidRedirectUri(pending.redirectUri)) {
      return reply.status(400).type('text/plain').send('invalid_request: redirect_uri failed validation');
    }
    const code = generateId();
    authCodes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    logger.info({ type: 'oauth_code_issued' }, 'oauth authorization code issued');
    reply.header('location', target.toString());
    return reply.status(302).send();
  });

  // ---- Token endpoint: exchange code for a per-client access token (PKCE S256) ----
  app.post('/oauth/token', async (req, reply) => {
    if (rateLimited(req.ip, 30)) return reply.status(429).send({ error: 'rate_limited' });
    const body =
      typeof req.body === 'string'
        ? Object.fromEntries(new URLSearchParams(req.body))
        : (req.body as Record<string, string>);
    const { grant_type, code, redirect_uri, client_id, code_verifier } = body ?? {};

    if (grant_type !== 'authorization_code') {
      return reply.status(400).send({ error: 'unsupported_grant_type' });
    }
    if (!code) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'code required' });
    }
    const authCode = authCodes.get(code);
    if (!authCode) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired or invalid' });
    }
    authCodes.delete(code); // one-time use
    if (authCode.expiresAt < Date.now()) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired' });
    }
    if (redirect_uri && redirect_uri !== authCode.redirectUri) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    if (client_id && client_id !== authCode.clientId) {
      return reply.status(400).send({ error: 'invalid_client' });
    }
    // PKCE is mandatory (a challenge is always stored by /authorize).
    if (!code_verifier || !verifyS256(code_verifier, authCode.codeChallenge)) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'PKCE code_verifier invalid' });
    }
    const { token, expiresInSeconds } = mintAccessToken(authCode.clientId, ACCESS_TOKEN_TTL_MS);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ access_token: token, token_type: 'Bearer', expires_in: expiresInSeconds });
  });
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Test-only: clear in-memory state (clients / pending requests / codes / rate
 *  limiter) so each test runs in isolation. Not wired to any route. */
export function __resetOAuthStateForTests(): void {
  clients.clear();
  authzRequests.clear();
  authCodes.clear();
  rl.clear();
}
