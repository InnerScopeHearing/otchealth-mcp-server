import '../instrument.js'; // Datadog APM, must be first; no-ops unless DD_API_KEY is set.
import Fastify from 'fastify';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { registerHealth } from './health.js';
import { registerVersion } from './version.js';
import { registerAdmin } from './admin.js';
import { registerMcpRoutes } from './mcp.js';
import { registerOAuthRoutes } from './oauth.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: true,
  });

  // Parse URL-encoded bodies (needed for OAuth token endpoint)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-credentials', 'true');
      reply.header(
        'access-control-allow-headers',
        'Authorization, Content-Type, X-Correlation-Id, MCP-Protocol-Version, Mcp-Session-Id',
      );
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const ms = reply.elapsedTime;
    logger.debug(
      {
        type: 'http_response',
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        latency_ms: Math.round(ms),
        ip: request.ip,
      },
      'http response',
    );
  });

  registerHealth(app);
  registerVersion(app);
  registerAdmin(app);
  registerOAuthRoutes(app);
  registerMcpRoutes(app);

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message:
        'Route not found. Known routes: GET /health, GET /healthz, GET /version, POST /mcp, GET /oauth/authorize, POST /oauth/token, GET /.well-known/oauth-authorization-server, POST /admin/revoke.',
    });
  });

  app.setErrorHandler(async (error: unknown, _request, reply) => {
    const e = error as Error;
    logger.error(
      {
        type: 'fastify_error',
        err: e.message,
        stack: e.stack,
      },
      'unhandled fastify error',
    );
    if (!reply.sent) {
      await reply.code(500).send({
        error: 'internal_error',
        message: 'Unexpected server error. Check logs for details.',
      });
    }
  });

  try {
    const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(
      {
        type: 'server_started',
        address,
        port: env.PORT,
        read_only_mode: env.READ_ONLY_MODE,
        enable_write_tools: env.ENABLE_WRITE_TOOLS,
        enable_high_risk_tools: env.ENABLE_HIGH_RISK_TOOLS,
        dry_run_default: env.DRY_RUN_DEFAULT,
        cio_workspace: env.CIO_WORKSPACE_ID,
      },
      'OTCHealth MCP server listening',
    );
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[fatal]', err);
  process.exit(1);
});
