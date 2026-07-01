import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../config/env.js';
import { getRevocationState } from '../auth/revocation-store.js';
import { toolCount } from '../catalog/catalog.js';
import { currentGovernanceMode } from '../governance/charter-enforcer.js';
import { validateAdminToken } from '../auth/bearer.js';
import { probeDependencies } from './deep-health.js';

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
    cio_workspace_id: env.CIO_WORKSPACE_ID,
    connector_token_revoked: rev.revoked_token_hash !== null,
    // Regression guard: the deploy pipeline asserts this stays >= the expected catalog size,
    // so a build that drops the tool surface (as happened 2026-07-01) fails the health gate.
    tool_count: toolCount(),
    // Observability for the charter-enforcer rollout (report/enforce/off). Read fresh on every
    // call (see currentGovernanceMode), so an ops flip via the app-settings env is visible here
    // without a redeploy. This route stays dependency-free on purpose (LB/uptime probes hit it),
    // so it must never grow a Cosmos/Search/Foundry call; see GET /health/deep for that.
    governance_mode: currentGovernanceMode(),
  };
}

export function registerHealth(app: FastifyInstance): void {
  app.get('/health', async () => buildHealthPayload());

  // GET /health/deep: bounded reachability probe of every CONFIGURED downstream dependency
  // (Cosmos, Azure AI Search, Foundry), plus governance_mode. Distinct from /health: this route
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
      governance_mode: currentGovernanceMode(),
    });
  });
}
