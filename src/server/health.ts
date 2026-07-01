import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../config/env.js';
import { getRevocationState } from '../auth/revocation-store.js';
import { toolCount } from '../catalog/catalog.js';

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
  };
}

export function registerHealth(app: FastifyInstance): void {
  app.get('/health', async () => buildHealthPayload());
}
