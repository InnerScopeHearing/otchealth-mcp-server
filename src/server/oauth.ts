/**
 * OAuth 2.1 endpoints for MCP authorization (per the MCP 2025-06-18 spec).
 *
 * The MCP server is an OAuth 2.1 RESOURCE SERVER and also hosts its (minimal)
 * authorization server. Implemented to satisfy the spec MUSTs:
 *   - RFC 9728 Protected Resource Metadata  (/.well-known/oauth-protected-resource)
 *   - WWW-Authenticate on 401               (added in auth/bearer.ts)
 *   - RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server)
 *   - OAuth 2.1 authorization_code + PKCE     (/oauth/authorize, /oauth/token)
 * and the SHOULDs:
 *   - RFC 7591 Dynamic Client Registration    (/register)
 *
 * SECURITY MODEL (this gateway is keys-to-the-kingdom on the public internet):
 *   - Dynamic Client Registration is OPEN (it only hands out a client_id; per the
 *     spec, registration does not grant access). The ACCESS gate is the
 *     resource-owner CONSENT step at /oauth/authorize: the human (Matt) must enter
 *     the consent secret in the browser before any authorization code is issued.
 *     Without that secret, no code is issued, so a stranger who registers a client
 *     still cannot obtain a token.
 *   - redirect_uri is validated: for DCR clients it MUST exact-match a registered
 *     value (anti open-redirect); all redirect_uris MUST be https or localhost.
 *   - The issued access_token is the connector bearer (robust across restarts; the
 *     /mcp bearer check in auth/bearer.ts is unchanged). The consent gate ensures
 *     only the operator can ever complete the flow.
 *   - Consent secret = OAUTH_CONSENT_SECRET if set, else ADMIN_REVOKE_TOKEN
 *     (separate from the issued bearer; the operator already holds it).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

// In-memory authorization code store (short-lived, cleared on restart).
const authCodes = new Map<
  string,
  {
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    expiresAt: number;
  }
>();

// In-memory dynamically-registered clients (RFC 7591). Cleared on restart; the
// client (e.g. claude.ai) transparently re-registers if its client_id stops
// working, so this does not need to be durable.
const clients = new Map<string, { redirectUris: string[]; createdAt: number }>();

// Clean up expired auth codes every 60s.
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 60_000).unref?.();

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifyCodeChallenge(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = createHash('sha256').update(verifier).digest('base64url');
    return safeEqual(hash, challenge);
  }
  return safeEqual(verifier, challenge); // plain
}

/** The secret the operator must enter at the consent screen. */
function consentSecret(): string {
  return env.OAUTH_CONSENT_SECRET || env.ADMIN_REVOKE_TOKEN;
}

/** Stable public base URL (issuer / resource). Behind the Cloudflare proxy,
 *  trustProxy makes protocol=https and hostname=mcp.otchealth.app. */
function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.hostname}`;
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve + validate the client_id and redirect_uri for an authorization
 * request. Returns null (and the caller renders an error) when invalid.
 * Accepts two client kinds:
 *   - a DCR-registered client (redirect_uri MUST exact-match its registered set)
 *   - the connector bearer used directly as a client_id (manual/non-DCR fallback)
 */
function resolveClient(clientId: string | undefined, redirectUri: string | undefined):
  | { ok: true }
  | { ok: false; error: string; description: string } {
  if (!clientId) return { ok: false, error: 'invalid_client', description: 'client_id required' };
  if (!redirectUri) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri required' };
  }
  if (!isValidRedirectUri(redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri must be https or localhost' };
  }
  const registered = clients.get(clientId);
  if (registered) {
    if (!registered.redirectUris.includes(redirectUri)) {
      return { ok: false, error: 'invalid_request', description: 'redirect_uri not registered for this client' };
    }
    return { ok: true };
  }
  // Non-DCR fallback: the connector token itself acts as a pre-shared client_id.
  if (safeEqual(clientId, env.PERPLEXITY_CONNECTOR_TOKEN)) return { ok: true };
  return { ok: false, error: 'invalid_client', description: 'unknown client_id (register via /register first)' };
}

function renderConsentPage(params: Record<string, string>): string {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'resource', 'scope']
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k] ?? '')}">`)
    .join('\n      ');
  const redirectHost = (() => {
    try {
      return new URL(params.redirect_uri ?? '').host;
    } catch {
      return params.redirect_uri ?? '';
    }
  })();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTCHealth MCP - Authorize</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1e293b;padding:2rem;border-radius:12px;max-width:420px;width:90%;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  h1{font-size:1.25rem;margin:0 0 .5rem} p{color:#94a3b8;font-size:.9rem;line-height:1.4}
  code{background:#0f172a;padding:.1rem .35rem;border-radius:4px;color:#7dd3fc}
  input[type=password]{width:100%;padding:.7rem;margin:.75rem 0;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;box-sizing:border-box}
  button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#0d9488;color:#fff;font-weight:600;cursor:pointer}
</style></head>
<body><form class="card" method="POST" action="/oauth/authorize">
  <h1>Authorize MCP connector</h1>
  <p>A client at <code>${escapeHtml(redirectHost)}</code> is requesting access to the OTCHealth fleet gateway. Enter the operator consent secret to approve.</p>
  ${hidden}
  <input type="password" name="consent_secret" placeholder="Consent secret" autocomplete="off" autofocus required>
  <button type="submit">Approve</button>
  <p style="margin-top:1rem;font-size:.78rem">This grants the connecting client access to the gateway tools. Only approve clients you initiated.</p>
</form></body></html>`;
}

function issueCode(
  reply: FastifyReply,
  p: Record<string, string>,
): void {
  const code = generateToken();
  authCodes.set(code, {
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge,
    codeChallengeMethod: p.code_challenge_method ?? 'plain',
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
  });
  const url = new URL(p.redirect_uri);
  url.searchParams.set('code', code);
  if (p.state) url.searchParams.set('state', p.state);
  logger.info({ type: 'oauth_code_issued', client_id_present: true }, 'oauth authorization code issued');
  void reply.status(302).redirect(url.toString());
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  // ---- RFC 8414: Authorization Server Metadata ----
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const b = baseUrl(req);
    return reply.send({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });
  });

  // ---- RFC 9728: Protected Resource Metadata (MUST) ----
  app.get('/.well-known/oauth-protected-resource', async (req, reply) => {
    const b = baseUrl(req);
    return reply.send({
      resource: b,
      authorization_servers: [b],
      bearer_methods_supported: ['header'],
      resource_documentation: `${b}/health`,
    });
  });
  // Some clients append the resource path when probing PRM; serve it there too.
  app.get('/.well-known/oauth-protected-resource/mcp', async (req, reply) => {
    const b = baseUrl(req);
    return reply.send({ resource: b, authorization_servers: [b], bearer_methods_supported: ['header'] });
  });

  // ---- RFC 7591: Dynamic Client Registration (SHOULD) ----
  app.post('/register', async (req, reply) => {
    const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) as
      | Record<string, unknown>
      | undefined;
    const redirectUris = Array.isArray(body?.redirect_uris)
      ? (body!.redirect_uris as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
    if (redirectUris.length === 0 || !redirectUris.every(isValidRedirectUri)) {
      return reply.status(400).send({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array of https (or localhost) URIs',
      });
    }
    const clientId = `mcp-${generateToken()}`;
    clients.set(clientId, { redirectUris, createdAt: Date.now() });
    logger.info({ type: 'oauth_client_registered', redirect_uris: redirectUris.length }, 'dcr client registered');
    reply.header('Cache-Control', 'no-store');
    return reply.status(201).send({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client (PKCE)
    });
  });

  // ---- Authorization endpoint: GET shows the operator consent screen ----
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.response_type !== 'code') {
      return reply.status(400).type('text/plain').send('unsupported_response_type (expected code)');
    }
    const check = resolveClient(q.client_id, q.redirect_uri);
    if (!check.ok) {
      return reply.status(400).type('text/plain').send(`${check.error}: ${check.description}`);
    }
    return reply.status(200).type('text/html').send(renderConsentPage(q));
  });

  // ---- Authorization endpoint: POST processes consent + issues the code ----
  app.post('/oauth/authorize', async (req, reply) => {
    const p = (typeof req.body === 'string'
      ? Object.fromEntries(new URLSearchParams(req.body))
      : (req.body as Record<string, string>)) ?? {};
    if (p.response_type !== 'code') {
      return reply.status(400).type('text/plain').send('unsupported_response_type');
    }
    const check = resolveClient(p.client_id, p.redirect_uri);
    if (!check.ok) {
      return reply.status(400).type('text/plain').send(`${check.error}: ${check.description}`);
    }
    // Resource-owner consent gate. Constant-time compare; never logged.
    if (!p.consent_secret || !safeEqual(p.consent_secret, consentSecret())) {
      logger.warn({ type: 'oauth_consent_rejected', ip: req.ip }, 'oauth consent secret rejected');
      return reply.status(401).type('text/html').send(
        renderConsentPage(p).replace(
          '<h1>Authorize MCP connector</h1>',
          '<h1>Authorize MCP connector</h1><p style="color:#f87171">Incorrect consent secret, try again.</p>',
        ),
      );
    }
    return issueCode(reply, p);
  });

  // ---- Token endpoint: exchange code for the access token (PKCE enforced) ----
  app.post('/oauth/token', async (req, reply) => {
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
    // PKCE: if a challenge was registered at /authorize, a matching verifier is required.
    if (authCode.codeChallenge) {
      if (!code_verifier) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'code_verifier required' });
      }
      if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod ?? 'plain')) {
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

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
