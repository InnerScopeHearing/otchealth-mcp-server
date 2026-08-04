import '../instrument.js'; // Datadog APM, must be first; no-ops unless DD_API_KEY is set.
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { registerHealth } from './health.js';
import { registerAdmin } from './admin.js';
import { registerMcpRoutes } from './mcp.js';
import { registerOAuthRoutes } from './oauth.js';
import { registerWebhookRoutes } from './webhooks.js';
import { loadRevocations, startRevocationReloader } from '../auth/revocation-store.js';
import { startDeindexResweepReloader } from '../agentstate/deindex-resweep.js';

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

  // Parse JSON but ALSO retain the raw string on request.rawBody — needed to verify GitHub
  // webhook HMAC signatures. MCP/other routes keep using the parsed request.body unchanged.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
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

  // Inbound rate limiting. The gateway is the keys-to-the-kingdom front door, so cap per-client
  // request rate (defense in depth on top of Cloudflare edge limits + Bearer auth). A generous
  // global default guards every route from floods; the OAuth endpoints set much stricter per-route
  // limits (server/oauth.ts). /health is exempt so uptime monitoring is never throttled.
  //
  // Rate key = req.ip (the @fastify/rate-limit default), derived from the trusted proxy chain
  // (trustProxy is on). We deliberately do NOT key on the client-controlled CF-Connecting-IP /
  // True-Client-IP headers: a caller that reaches the app directly (bypassing Cloudflare) could
  // forge them to rotate the key and slip the per-IP limit. The definitive spoof-resistance is the
  // network-layer Cloudflare-only ingress lock (infra, tracked separately); once that is enforced,
  // every request provably transits Cloudflare and req.ip / the CF headers become authoritative.
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
  });

  registerHealth(app);
  registerAdmin(app);
  registerOAuthRoutes(app);
  registerMcpRoutes(app);
  registerWebhookRoutes(app);

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message:
        'Route not found. Known routes: GET /health, POST /mcp, GET /oauth/authorize, POST /oauth/token, GET /.well-known/oauth-authorization-server, POST /admin/revoke.',
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

  // Load the durable token-revocation blocklist into memory BEFORE accepting requests, so a leaked
  // token that was revoked stays rejected across restarts / blue-green redeploys (the blocklist is
  // persisted in Cosmos). Fail-open by construction (loadRevocations never throws).
  const revokedCount = await loadRevocations();
  if (revokedCount > 0) {
    logger.warn({ type: 'revocations_loaded', count: revokedCount }, 'loaded durable token revocations at boot');
  }
  // Behind Front Door / APIM the gateway can run >1 replica; a /admin/revoke only lands on one. This
  // reconciler re-pulls the durable blocklist from Cosmos on an interval so any revoke reaches every
  // replica within ~30s without a restart. Idempotent; no-op without Cosmos; unref'd (never blocks exit).
  startRevocationReloader();
  // THE PERMANENT FIX for the concurrent-pull-indexer resurrection race documented throughout PR #192
  // (search-write.ts's module doc comment, "KNOWN RESIDUAL LIMITATION"): a delayed re-verification
  // sweep over paths legal_blob_delete/legal_blob_move already enqueued, run safely past one full
  // indexer cadence so it never races the same in-flight run the synchronous cleanup could. See
  // agentstate/deindex-resweep.ts's module doc comment for the full design. Idempotent; no-op without
  // Cosmos; unref'd; safe to run redundantly across replicas (deindexChunkedPath is idempotent).
  startDeindexResweepReloader();

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
