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
  /**
   * True when auth resolved via one of the M365 declarative-agent static per-lane tokens (see
   * m365StaticAgentTokens below). WHY THIS EXISTS (2026-07-25): M365 Copilot's own tool-calling
   * orchestrator was confirmed (direct reproduction) NOT to reliably follow the gateway's JIT
   * result-offload pattern (a large tool result replaced with a stub + a pointer to call
   * gateway_fetch_result for the full payload) -- Copilot sees the stub and reports "no content
   * available" rather than chaining into the follow-up tool, even when gateway_fetch_result is a
   * declared, callable tool on that same agent. Since M365 callers can't reliably use the two-hop
   * pattern, registry.ts uses this flag to skip offloading entirely for them and return the full
   * inline payload instead (see registry.ts's shouldOffload call site). Other engines (Claude Code,
   * Hyperagent) are UNCHANGED -- they reliably chain into gateway_fetch_result today.
   */
  m365_static_auth: boolean;
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header.
 *
 * DELIBERATELY REGEX-FREE (2026-08-17, CodeQL js/polynomial-redos, high). The previous form was
 * `/^Bearer\s+(.+)$/i`, where `\s+` and `(.+)` can BOTH match a space. That ambiguity makes the
 * match polynomial: `"Bearer " + " ".repeat(n)` forces the engine to try every split point before
 * failing. This runs on a fully UNAUTHENTICATED path against a header an attacker controls
 * completely, so it is a real (if modest) DoS vector rather than a theoretical one -- and the
 * auth_rejected diagnostics in this same change call extractBearer a SECOND time per rejected
 * request, which doubled the cost and is what surfaced the alert.
 *
 * The character-wise form below is linear and preserves the old semantics exactly: the literal
 * "Bearer" (case-insensitive), then one or more whitespace characters, then the token, trimmed.
 * The only regex left is a single-character test, which cannot backtrack.
 */
function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const SCHEME = 'bearer';
  if (authHeader.length <= SCHEME.length) return null;
  if (authHeader.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return null;
  const rest = authHeader.slice(SCHEME.length);
  // The scheme must be followed by whitespace, or "BearerXYZ" would parse as the token "XYZ".
  if (!/^\s/.test(rest)) return null;
  const token = rest.trim();
  return token || null;
}

/**
 * Extract the M365 declarative-agent static token from the request's query string.
 *
 * WHY THIS EXISTS (2026-07-25, fleet-wide MCP wiring; RE-VERIFIED 2026-08-18 against a HIGH
 * security finding — a bearer credential in a URL query string is exposed anywhere URLs get
 * recorded: proxy/gateway access logs, CDN logs, Referer headers, browser/client history, crash
 * reports, any error message that echoes the request line): a Microsoft 365 declarative agent's
 * "RemoteMCPServer" runtime (api_plugin.json schema v2.4). Two modes were evaluated when this
 * design was chosen and both were ruled out. ApiKeyPluginVault is a syntactically valid enum value
 * in the runtime authentication object, but Microsoft's docs state twice, independently — the
 * authentication-schemes overview and the API-key-specific how-to — that "Model Context Protocol
 * (MCP) plugins don't support API key authentication," so it is not a real option for this runtime
 * regardless of what the schema will accept. OAuthPluginVault's auth-config record can only be
 * created through the Teams Developer Portal UI (no Graph API or CLI path), AND is a genuine
 * per-user interactive OAuth 2.0 authorization-code flow (a human signs in and clicks Allow) — a
 * different, heavier authentication model than "this same static per-lane secret, delivered over a
 * header," not a drop-in replacement for it.
 *
 * WHAT THIS COMMENT MUST NOT CLAIM (corrected 2026-08-18, and the correction is the point): an
 * earlier draft of this very block concluded from the two rulings above that "no non-interactive
 * header-capable mechanism exists for this runtime today." That does not follow, and it is false as
 * written. Two candidates examined and rejected establishes that THOSE TWO do not work; it
 * establishes nothing about a third. A re-fetch of the cited Microsoft Learn pages on 2026-08-18
 * found DYNAMIC CLIENT REGISTRATION listed as supported for this runtime and described as
 * automatic, and DCR was simply never considered when the query-string shape was picked in July.
 * This gateway already has the RFC 9728 protected-resource-metadata and PKCE machinery DCR builds
 * on. So the honest state is: no header-capable mechanism has been IMPLEMENTED, one documented
 * candidate is untried, and the path is open rather than foreclosed. Do not re-derive "impossible"
 * from this comment; an incomplete enumeration presented as an exhaustive one is exactly the defect
 * class the 2026-08-18 sweep exists to remove, and this block shipped an instance of it.
 *
 * DECISION (2026-08-18): this gateway KEEPS accepting the query-string token as a deliberate,
 * documented choice — resting on the fact that all six M365 agents are ALREADY PUBLISHED carrying
 * that URL, so rejecting it before a replacement is built and republished is a self-inflicted
 * outage rather than a security improvement. It does NOT rest on the alternatives being exhausted;
 * see above, they are not. The real, shippable mitigation meanwhile lives in what this
 * process itself controls: server/response-log.ts strips the query string from every URL this
 * gateway writes to its OWN structured logs, closing the "gateway access logs" arm of the exposure
 * above. It cannot close the CDN/proxy/browser-history arms — those layers are outside this
 * process's control, and the credential is, unavoidably today, part of a URL. Any token published
 * in this form must be treated as exposed and rotated; see build-agents.mjs (otchealth-cto) for the
 * client-side half of this same finding and the full citation trail.
 *
 * With auth:None, Copilot's MCP runtime injects NO header of any kind — the ONLY thing under our
 * control is the static `spec.url` baked into the published manifest. So the credential has to
 * travel as part of that URL, and a query string is the only part of a URL a JSON-RPC-over-HTTP
 * POST reliably preserves end to end. Rotating a token means republishing that agent's app package
 * (Graph POST to appCatalogs/teamsApps), the same non-interactive mechanism already used to publish
 * it in the first place.
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
 * Static per-seat tokens for OpenAI Codex, mirroring m365StaticAgentTokens() above. Codex presents
 * these as a REAL Authorization: Bearer header (its `bearer_token_env_var` config), never the M365
 * query-string carrier. See CODEX_CTO_MCP_TOKEN's comment in config/env.ts for why they exist (this
 * Codex build does not persist its OAuth token across a restart). A match resolves to the SAME lane
 * identity the OAuth seat would get, and is flagged connector_surface=true (see validateBearer) so
 * the seat receives the curated per-lane connector toolset rather than the raw internal catalog.
 */
function codexStaticAgentTokens(): Record<string, string> {
  return {
    cto: env.CODEX_CTO_MCP_TOKEN,
    cfo: env.CODEX_CFO_MCP_TOKEN,
    clo: env.CODEX_CLO_MCP_TOKEN,
    coo: env.CODEX_COO_MCP_TOKEN,
    cro: env.CODEX_CRO_MCP_TOKEN,
    developer: env.CODEX_DEVELOPER_MCP_TOKEN,
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
  // low-priv COPILOT_AGENT_TOKEN (identity='copilot-agent') for the GitHub Copilot autonomous
  // issue-assignment coding agents' MCP header; (4b) the long-lived COPILOT_DEV_AGENT_TOKEN
  // (identity='developer') for the 'otchealth-dev' user-invocable GitHub Copilot CUSTOM AGENT's
  // MCP header -- deliberately a SEPARATE static token from COPILOT_AGENT_TOKEN (2026-07-26,
  // see env.ts's header on COPILOT_DEV_AGENT_TOKEN for why: different trust profile, independent
  // rotation); (5) one of the M365 declarative-agent per-lane static tokens (see
  // m365StaticAgentTokens above) for each fleet agent's own MCP runtime (see extractQueryToken's
  // header for why these travel as a query-string value wrapped into a synthetic "Bearer <token>"
  // string by requireConnectorAuth below, rather than a real Authorization header); (6) one of
  // the Codex per-seat static tokens (see codexStaticAgentTokens above), presented as a REAL
  // Authorization header and flagged connector_surface. All rotate-before-launch.
  const issued = isValidIssuedAccessToken(token);
  let descopeAgent: string | null = null;
  let staticAgent: string | null = null;
  let isM365Static = false;
  let isCodexStatic = false;
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
      } else if (env.EVAL_AGENT_TOKEN && env.EVAL_AGENT_TOKEN.length >= 32 && safeEqual(token, env.EVAL_AGENT_TOKEN)) {
        // The scheduled eval harness (src/eval/eval-runner.mjs). Same low-priv lane as
        // copilot-agent -- see EVAL_AGENT_TOKEN's own comment in config/env.ts for why this token
        // exists as a dedicated credential rather than reusing PERPLEXITY_CONNECTOR_TOKEN.
        staticAgent = 'copilot-agent';
      } else if (env.COPILOT_DEV_AGENT_TOKEN && env.COPILOT_DEV_AGENT_TOKEN.length >= 32 && safeEqual(token, env.COPILOT_DEV_AGENT_TOKEN)) {
        // 'otchealth-dev' (.github-private/agents/otchealth-dev.agent.md) -- a user-invocable
        // GitHub Copilot custom agent with a real app-build job, a different trust profile than
        // the autonomous issue-assignment coding agent above. Maps to caller_agent='developer',
        // the SAME lane the Hyperagent "OTCHealth Gateway (Developer)" skill and
        // M365_DEVELOPER_MCP_TOKEN already reach -- this widens WHICH FRONT DOOR can reach that
        // lane, not what the lane itself can do.
        staticAgent = 'developer';
      } else {
        const m365Hit = Object.entries(m365StaticAgentTokens()).find(
          ([, v]) => v && v.length >= 32 && safeEqual(token, v),
        );
        if (m365Hit) {
          staticAgent = m365Hit[0];
          isM365Static = true;
        } else {
          const codexHit = Object.entries(codexStaticAgentTokens()).find(
            ([, v]) => v && v.length >= 32 && safeEqual(token, v),
          );
          if (codexHit) {
            staticAgent = codexHit[0];
            isCodexStatic = true;
          } else {
            return null;
          }
        }
      }
    }
  }
  const caller_agent = issued ? (issuedAgent(token) || '') : (descopeAgent || staticAgent || '');
  const clientId = issued ? issuedClientId(token) : null;
  // Connector clients: DCR public clients (dcr_) OR manually-registered confidential connector clients
  // (occ_ = OTCHealth Connector Client) entered in Claude's Advanced settings to bypass the DCR tool-delivery
  // bug (modelcontextprotocol#1675). Both get the curated, spec-bare connector surface.
  // A Codex static per-seat token (codexStaticAgentTokens) is ALSO connector surface: the seat gets the
  // curated per-lane connector toolset, exactly as if it had elevated to that lane via OAuth.
  const connector_surface =
    Boolean(clientId && (clientId.startsWith('dcr_') || clientId.startsWith('occ_'))) || isCodexStatic;
  return { caller_hash: hashToken(token), raw_token: token, caller_agent, connector_surface, m365_static_auth: isM365Static };
}

export function validateAdminToken(authHeader: string | undefined): boolean {
  const token = extractBearer(authHeader);
  if (!token) return false;
  return safeEqual(token, env.ADMIN_REVOKE_TOKEN);
}

/**
 * Build the structured payload for an `auth_rejected` log line.
 *
 * WHY THIS IS A SEPARATE, EXPORTED FUNCTION (2026-08-17): for months this log carried only route +
 * ip, so a background internet scanner and a real fleet client sending a stale credential produced
 * byte-identical lines. That ambiguity cost an hour of log archaeology during the Hyperagent
 * connection outage -- the logs could not answer "is anyone failing auth, and who." Extracting the
 * payload makes it a value a test can assert on directly; capturing pino's real output is not
 * viable here because it writes to fd 1 via sonic-boom, bypassing `process.stdout.write`, so a
 * stdout spy silently observes nothing.
 *
 *   reason      separates "sent no credential at all" (an MCP client's normal pre-discovery probe,
 *               and every unauthenticated scanner -- benign, expect a steady trickle) from "sent
 *               something we do not recognise" (a REAL misconfiguration: a stale or wrong
 *               credential) and from "revoked" (a known-killed token still in use). A revoked token
 *               also emits its own auth_revoked line in validateBearer; restating it here lets a
 *               single query over auth_rejected classify every failure without a join.
 *   client      the User-Agent, which is what actually names the calling platform. Not sensitive.
 *   caller_hash the SHA256 of the presented credential, NEVER the credential -- exactly the
 *               treatment auth_revoked has always used -- so repeated failures can be correlated as
 *               "the same stale token" without the value ever reaching a log. OMITTED entirely when
 *               nothing was presented, so its presence alone means a credential was actually sent.
 *
 * This runs on an UNAUTHENTICATED path, so every field here is attacker-influenced content landing
 * in retained logs. That is why the credential is hashed rather than echoed.
 */
export function authRejectionLogFields(request: FastifyRequest): Record<string, unknown> {
  const presented = extractBearer(request.headers['authorization']) ?? extractQueryToken(request);
  const reason = !presented
    ? 'no_credential'
    : isRevoked(presented)
      ? 'revoked'
      : 'unrecognized_credential';
  return {
    type: 'auth_rejected',
    route: request.routeOptions?.url ?? request.url,
    ip: request.ip,
    reason,
    client: request.headers['user-agent'] ?? null,
    ...(presented ? { caller_hash: hashToken(presented) } : {}),
  };
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
    // WHY THESE THREE EXTRA FIELDS (2026-08-17): for months this log carried only route + ip, which
    // cannot tell a background internet scanner apart from a real fleet client that is misconfigured
    // -- on the reject path both look identical. Diagnosing the Hyperagent connection outage meant
    // an hour of log archaeology that these fields would have answered in one query, so the gap is
    // paid for once here instead of every future incident.
    //
    //   reason      separates "sent no credential at all" (an MCP client's normal pre-discovery
    //               probe, and every unauthenticated scanner -- benign, expect a steady trickle)
    //               from "sent something we do not recognise" (a REAL misconfiguration: a stale or
    //               wrong credential) and from "revoked" (a known-killed token still in use). Note a
    //               revoked token also emits its own auth_revoked line in validateBearer; this
    //               restates it here so a single query over auth_rejected classifies every failure.
    //   client      the User-Agent, which is what actually names the calling platform. Not sensitive.
    //   caller_hash the SHA256 of the presented credential, NEVER the credential -- exactly the
    //               treatment auth_revoked has always used -- so repeated failures can be correlated
    //               as "the same stale token" without the value ever reaching a log. Omitted entirely
    //               when nothing was presented, so its presence alone means a credential was sent.
    logger.warn(authRejectionLogFields(request), 'connector auth rejected');
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
