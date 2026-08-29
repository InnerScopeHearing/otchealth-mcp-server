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
import { defaultSetupCodeDeps, isElevationRole, type SetupCodeDeps } from '../auth/setup-codes.js';
import {
  applyConsentPageHeaders,
  buildAuthorizeRedirectUrl,
  createPendingAuth,
  defaultOAuthConsentDeps,
  isValidPendingAuthId,
  renderConsentPage,
  renderDeadEndPage,
  resolveElevateChoice,
  resolveReadOnlyChoice,
  type OAuthConsentDeps,
} from './oauth-consent.js';
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

/**
 * Storage deps for the consent interstitial, injectable so a hermetic test can exercise the REAL
 * Fastify routes (via app.inject()) end to end with a fake in-memory store instead of a live
 * Postgres/Cosmos instance -- mirroring server/heygen-pairing.ts's registerHeyGenPairingRoute(app,
 * deps) convention. Both fields default to the real agentstate/store.ts-backed implementations, so
 * every existing call site (server/index.ts's plain `registerOAuthRoutes(app)`) is unaffected.
 */
export interface OAuthRouteDeps {
  consent?: OAuthConsentDeps;
  setupCode?: SetupCodeDeps;
}

export function registerOAuthRoutes(app: FastifyInstance, routeDeps: OAuthRouteDeps = {}): void {
  const consentDeps = routeDeps.consent ?? defaultOAuthConsentDeps;
  const setupCodeDeps = routeDeps.setupCode ?? defaultSetupCodeDeps;
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

    // Hoisted so the interstitial branch below (which runs AFTER every validation check in this
    // block, unchanged) can read what client this request resolved to. Declaring it here changes
    // only its SCOPE, not its value or the checks performed on it -- the confidential-client and
    // legacy (!oauthConfigured()) branches immediately below are otherwise byte-for-byte identical
    // to before this feature.
    let ac: ResolvedAnyClient | null = null;
    if (oauthConfigured()) {
      ac = client_id ? resolveAnyClient(client_id) : null;
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

    // ── Consent interstitial (owner-code role elevation), PUBLIC/DCR clients ONLY ───────────────
    // Confidential clients (occ_/OAUTH_CLIENTS, ac.isPublic === false) and the legacy
    // (!oauthConfigured()) fallback fall straight through to the unchanged auto-issue below --
    // BYTE-FOR-BYTE, per the guard on this very branch. A public DCR client carries NO identity
    // proof (see /register's Part 6 comment above) and is hard-bound to external-read; this is the
    // ONLY place such a client can ever reach a privileged lane, and doing so requires a genuine
    // owner-minted setup code (connector_setup_code_create, cto/exec-gated) typed into THIS page by
    // a human in their own browser -- the connecting client itself never sees it.
    if (oauthConfigured() && ac && ac.isPublic) {
      let pending: { id: string };
      try {
        pending = await createPendingAuth(
          {
            clientId: client_id,
            redirectUri: redirect_uri,
            state,
            codeChallenge: code_challenge,
            codeChallengeMethod: 'S256',
          },
          consentDeps,
        );
      } catch (e) {
        // FAIL LOUD: a storage error here must never fall through to the auto-issue below, which
        // would silently disable the whole consent step (and grant external-read with no owner
        // visibility at all) rather than surfacing an obvious failure.
        logger.error(
          { type: 'oauth_authorize_pending_error', error: (e as Error).message },
          'failed to create pending-auth record for the consent interstitial',
        );
        applyConsentPageHeaders(reply);
        return reply.status(500).send(renderDeadEndPage('server_error'));
      }
      applyConsentPageHeaders(reply);
      return reply.status(200).send(renderConsentPage(pending.id));
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

  // ── Consent submission: the interstitial's form posts back HERE ────────────────────────────────
  // Carries ONLY pending_id + the owner's choice (+ the code, if elevating) -- NEVER redirect_uri/
  // state/PKCE, which are resolved server-side from the stored pending-auth record (see
  // oauth-consent.ts's header). Same brute-force-surface posture as /oauth/authorize itself: a
  // strict per-route rate limit, in addition to the setup code's own 80 bits of entropy and the
  // pending record's independent 5-wrong-guess budget.
  app.post('/oauth/authorize/consent', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    try {
      const body =
        typeof req.body === 'string'
          ? (Object.fromEntries(new URLSearchParams(req.body)) as Record<string, string>)
          : ((req.body ?? {}) as Record<string, string>);
      const pendingId = typeof body.pending_id === 'string' ? body.pending_id : '';
      const action = body.action === 'elevate' ? 'elevate' : body.action === 'readonly' ? 'readonly' : '';

      if (!isValidPendingAuthId(pendingId) || !action) {
        applyConsentPageHeaders(reply);
        return reply.status(400).send(renderDeadEndPage('expired'));
      }

      const resolved =
        action === 'readonly'
          ? await resolveReadOnlyChoice(pendingId, consentDeps)
          : await resolveElevateChoice(pendingId, body.code || '', consentDeps, setupCodeDeps);

      if (resolved.outcome === 'store_error') {
        applyConsentPageHeaders(reply);
        return reply.status(500).send(renderDeadEndPage('server_error'));
      }
      if (resolved.outcome === 'burned') {
        applyConsentPageHeaders(reply);
        return reply.status(400).send(renderDeadEndPage('expired'));
      }
      if (resolved.outcome === 'retry') {
        applyConsentPageHeaders(reply);
        return reply.status(200).send(renderConsentPage(pendingId, resolved.message));
      }

      // resolved.outcome === 'issue'. SECURITY (hostile-reviewer check): agentOverride here is
      // EITHER null (the explicit read-only choice, never touched auth/setup-codes.ts) OR a role
      // that auth/setup-codes.ts's consumeSetupCode() itself resolved from a durable doc -- never
      // anything this request's own body could name directly. There is no field in `body` that
      // selects a role.
      const code = await createAuthCode({
        clientId: resolved.clientId,
        redirectUri: resolved.redirectUri,
        scope: 'mcp',
        codeChallenge: resolved.codeChallenge,
        codeChallengeMethod: resolved.codeChallengeMethod,
        ...(resolved.agentOverride ? { elevatedAgent: resolved.agentOverride } : {}),
      });
      const url = buildAuthorizeRedirectUrl(resolved.redirectUri, code, resolved.state);
      logger.info(
        { type: 'oauth_authorize_consent', elevated: Boolean(resolved.agentOverride) },
        'issued auth code via the consent interstitial',
      );
      reply.header('cache-control', 'no-store');
      return reply.status(302).redirect(url);
    } catch (e) {
      // Same fail-loud posture as the GET handler above: an unexpected throw anywhere in this
      // handler must never escape as Fastify's default error page (which could leak internals) and
      // must never be mistaken for a completed flow.
      logger.error({ type: 'oauth_authorize_consent_error', error: (e as Error).message }, 'consent submission handler failed');
      applyConsentPageHeaders(reply);
      return reply.status(500).send(renderDeadEndPage('server_error'));
    }
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
        access_token: issueAccessToken(client_id, 'mcp', env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, rc.agent, env.OAUTH_CC_TTL_SECONDS),
        token_type: 'Bearer',
        expires_in: env.OAUTH_CC_TTL_SECONDS,
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
      // ELEVATION (owner-code role elevation, connector setup codes): for a PUBLIC (DCR) client,
      // resolveAnyClient()/parseStatelessClient() ALWAYS decodes the STATIC blob baked into the
      // client_id at /register time, which is ALWAYS 'external-read' -- it has no way to know an
      // elevation ever happened. The refresh token being refreshed here, however, is a credential
      // THIS SERVER minted, with `agent` in its own signed claims set to whatever the authorization_
      // code grant decided at issuance (either rc.agent, for an ordinary completion, or the
      // elevated role, for a consent-interstitial elevation -- see that branch below). Trusting
      // claims.agent for a public client is not a new trust decision: auth/bearer.ts's issuedAgent()
      // already treats a verified access token's own `agent` claim as authoritative everywhere else
      // in the system; this makes the refresh grant consistent with that, instead of silently
      // discarding an elevated role back to external-read on every refresh (the exact bug this
      // comment exists to prevent — a refreshed connector would otherwise quietly lose its granted
      // role a few hours after connecting). A CONFIDENTIAL client (rc.isPublic === false) is
      // UNCHANGED: it always re-derives rc.agent from OAUTH_CLIENTS, byte-for-byte as before, since
      // an operator-driven lane reassignment taking effect on that client's next refresh is an
      // existing, deliberate, and unrelated behavior this feature must not touch.
      const agent = rc.isPublic ? claims.agent || rc.agent : rc.agent;
      reply.header('Cache-Control', 'no-store');
      return reply.send({
        // Same 24h TTL as client_credentials (OAUTH_CC_TTL_SECONDS). The 2026-07-16 TTL fix only
        // covered the CC grant; Chat/Cowork connectors (authorization_code + refresh) kept the old
        // hardcoded 1h and dropped mid-session — the recurring "brain went offline" experience.
        access_token: issueAccessToken(claims.sub, claims.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, agent, env.OAUTH_CC_TTL_SECONDS),
        token_type: 'Bearer',
        expires_in: env.OAUTH_CC_TTL_SECONDS,
        refresh_token: issueRefreshToken(claims.sub, claims.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, agent, env.OAUTH_REFRESH_TTL_SECONDS),
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
      // ELEVATION (owner-code role elevation): rec.elevatedAgent is set ONLY by the consent
      // interstitial's resolveElevateChoice (server/oauth-consent.ts), and ONLY after
      // auth/setup-codes.ts's consumeSetupCode() atomically confirmed a genuine owner-minted code.
      // Two independent guards before this value is ever trusted to pick the token's agent:
      //   (1) rc.isPublic -- a CONFIDENTIAL client's rec can never carry elevatedAgent in practice
      //       (only the DCR interstitial branch in oauth.ts's GET handler sets it), but this makes
      //       that explicit rather than implicit: a confidential client's token is ALWAYS rc.agent,
      //       full stop, regardless of what a record might contain.
      //   (2) isElevationRole -- re-validates against the SAME allow-list auth/setup-codes.ts's
      //       assertMintableRole() enforced at mint time (cto/cfo/clo/coo/cro/developer; NEVER
      //       clo-personal). A future bug that somehow let a bad value into an AuthCodeRecord still
      //       could not be honored here -- it silently falls back to rc.agent (external-read for a
      //       DCR client) rather than granting an unvalidated string as a privileged identity.
      const agent =
        rc.isPublic && rec.elevatedAgent && isElevationRole(rec.elevatedAgent) ? rec.elevatedAgent : rc.agent;
      reply.header('Cache-Control', 'no-store');
      return reply.send({
        // 24h, matching the CC grant (see the refresh_token grant note above).
        access_token: issueAccessToken(rec.clientId, rec.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, agent, env.OAUTH_CC_TTL_SECONDS),
        token_type: 'Bearer',
        expires_in: env.OAUTH_CC_TTL_SECONDS,
        refresh_token: issueRefreshToken(rec.clientId, rec.scope, env.OAUTH_TOKEN_SIGNING_SECRET, baseUrl, agent, env.OAUTH_REFRESH_TTL_SECONDS),
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
