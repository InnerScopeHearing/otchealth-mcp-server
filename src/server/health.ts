import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { getRevocationState } from '../auth/revocation-store.js';
import { toolCount } from '../catalog/catalog.js';
import { validateAdminToken } from '../auth/bearer.js';
import { probeDependencies } from './deep-health.js';
import { heyGenApprovalCompatibilityFingerprints } from '../tools/heygen/approval-fingerprint.js';
import { HEYGEN_CRO_DIRECT_TOOLS } from '../tools/heygen/access.js';

const env = loadEnv();

/** The /health response body. Exported so it is unit-testable without standing up Fastify. */
export function buildHealthPayload() {
  const rev = getRevocationState();
  return {
    status: 'ok',
    service: 'otchealth-mcp-server',
    time: new Date().toISOString(),
    env: env.NODE_ENV,
    read_only_mode: env.READ_ONLY_MODE,
    enable_write_tools: env.ENABLE_WRITE_TOOLS,
    enable_high_risk_tools: env.ENABLE_HIGH_RISK_TOOLS,
    dry_run_default: env.DRY_RUN_DEFAULT,
    heygen: {
      provider_writes: env.ENABLE_HEYGEN_PROVIDER_WRITES,
      prompt_avatar_writes: env.ENABLE_HEYGEN_PROMPT_AVATAR_WRITES,
      avatar_video_writes: env.ENABLE_HEYGEN_AVATAR_VIDEO_WRITES,
      reference_look_writes: env.ENABLE_HEYGEN_REFERENCE_LOOK_WRITES,
      video_agent_chat_writes: env.ENABLE_HEYGEN_VIDEO_AGENT_CHAT_WRITES,
      video_agent_generation: env.ENABLE_HEYGEN_VIDEO_AGENT_GENERATION,
      asset_writes: env.ENABLE_HEYGEN_ASSET_WRITES,
      translation_writes: env.ENABLE_HEYGEN_TRANSLATION_WRITES,
      tts_writes: env.ENABLE_HEYGEN_TTS_WRITES,
      metadata_writes: env.ENABLE_HEYGEN_METADATA_WRITES,
      cro_direct_enabled: true,
      cro_direct_tools: [...HEYGEN_CRO_DIRECT_TOOLS],
      owner_approval_verifier_configured: Boolean(
        env.HEYGEN_OWNER_APPROVAL_SUBJECT && env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK,
      ),
      owner_approval_context_configured: env.HEYGEN_APPROVAL_CONTEXT_SECRET.length >= 32,
      owner_approval_handle_configured: env.HEYGEN_APPROVAL_HANDLE_SECRET.length >= 32,
      owner_approval_callback_configured: env.HEYGEN_APPROVAL_CALLBACK_SECRET.length >= 32,
      owner_approval_broker_configured: Boolean(env.HEYGEN_APPROVAL_BROKER_URL),
      owner_approval_issuer: env.HEYGEN_OWNER_APPROVAL_ISSUER,
      owner_approval_audience: env.HEYGEN_OWNER_APPROVAL_AUDIENCE,
      owner_approval_subject_sha256: env.HEYGEN_OWNER_APPROVAL_SUBJECT
        ? createHash('sha256').update(env.HEYGEN_OWNER_APPROVAL_SUBJECT, 'utf8').digest('hex')
        : undefined,
      owner_approval_compatibility: heyGenApprovalCompatibilityFingerprints({
        publicJwk: env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK,
        contextSecret: env.HEYGEN_APPROVAL_CONTEXT_SECRET,
        handleSecret: env.HEYGEN_APPROVAL_HANDLE_SECRET,
        callbackSecret: env.HEYGEN_APPROVAL_CALLBACK_SECRET,
      }),
    },
    cio_workspace_id: env.CIO_WORKSPACE_ID,
    connector_token_revoked: rev.revoked_token_hash !== null,
    // Regression guard: the deploy pipeline asserts this stays >= the expected catalog size,
    // so a build that drops the tool surface (as happened 2026-07-01) fails the health gate.
    tool_count: toolCount(),
  };
}

export function registerHealth(app: FastifyInstance): void {
  app.get('/health', async () => buildHealthPayload());

  // GET /health/deep: bounded reachability probe of every CONFIGURED downstream dependency
  // (Cosmos, Azure AI Search, Foundry). Distinct from /health: this route
  // is intentionally NOT on the fast path (it makes real network calls, each capped at 2s), so it
  // is gated to internal/CI callers via the existing ADMIN_REVOKE_TOKEN bearer (the same pattern
  // /admin/* already uses) rather than left open to public polling, which would let an outside
  // caller hammer Cosmos/Search/Foundry for free. It is NOT in the /health rate-limit allowList,
  // so it stays subject to the global inbound limit too.
  app.get('/health/deep', async (request, reply) => {
    if (!validateAdminToken(request.headers['authorization'])) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing or invalid admin token. Provide Authorization: Bearer <ADMIN_REVOKE_TOKEN>.',
      });
    }
    const deps = await probeDependencies();
    const anyDown = Object.values(deps).some((v) => v === 'down');
    return reply.code(anyDown ? 503 : 200).send({
      ...deps,
    });
  });
}
