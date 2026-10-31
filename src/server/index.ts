import '../instrument.js'; // Datadog APM, must be first; no-ops unless DD_API_KEY is set.
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { publicErrorResponse } from './public-error-response.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../audit/logger.js';
import { runCloudBrowserPolling } from './cloud-browser-runtime.js';
import { registerHealth } from './health.js';
import { registerAdmin } from './admin.js';
import { registerMcpRoutes } from './mcp.js';
import { registerOAuthRoutes } from './oauth.js';
import { registerHeyGenPairingRoute } from './heygen-pairing.js';
import { registerHeyGenApprovalCallback } from './heygen-approval-callback.js';
import { registerWebhookRoutes } from './webhooks.js';
import { registerGraphWorkerBrokerRoutes } from './graph-worker-broker.js';
import { createProductionIdentityRegistryResolver } from './identity-registry-production.js';
import { registerGraphCatalogControllerRoutes } from './graph-catalog-controller.js';
import { registerRelationshipArtifactGatewayRoutes } from './relationship-artifact-gateway.js';
import { registerRelationshipHistoricalReadRoutes } from './relationship-historical-read.js';
import { registerRelationshipPublicationRoutes } from './relationship-publication.js';
import { registerChatActionJobRoutes } from './chat-action-jobs.js';
import { registerChatActionRunRoute } from './chat-action-run-route.js';
import { createChatActionExecutor } from './chat-action-executor.js';
import { handleCheckpoint } from '../tools/memory/checkpoint.js';
import { queryDocs, readDoc, replaceDoc } from '../agentstate/store.js';
import {
  getRevocationStoreStatus,
  loadRevocations,
  startRevocationReloader,
} from '../auth/revocation-store.js';
import { startDeindexResweepReloader } from '../agentstate/deindex-resweep.js';
import { responseLogFields } from './response-log.js';
import { registerIntercomLoginRoutes } from './intercom-login.js';
import { intercomLoginRuntime, websiteLoginRuntime } from './cloud-browser-runtime.js';
import { registerWebsiteLoginRoutes } from './website-login.js';
import { registerConfiguredDaytonaViewerRoutes } from './daytona-runtime.js';
import { initializeStartup, registerOptionalDaytonaRoutes, startPostListenWorkers } from './startup-coordinator.js';

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
    // See response-log.ts's doc comment: the payload is built by a separate, testable function
    // specifically so the URL never carries a query-string secret (M365 static token, OAuth
    // `code`/`state`) into this log line, regardless of LOG_LEVEL.
    logger.debug(responseLogFields(request, reply, reply.elapsedTime), 'http response');
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
  registerHeyGenPairingRoute(app);
  registerHeyGenApprovalCallback(app);
  registerMcpRoutes(app);
  registerIntercomLoginRoutes(app, intercomLoginRuntime);
  registerWebsiteLoginRoutes(app, websiteLoginRuntime);
  await registerOptionalDaytonaRoutes(env, () => registerConfiguredDaytonaViewerRoutes(app));
  registerGraphWorkerBrokerRoutes(app, { identityRegistry: createProductionIdentityRegistryResolver() });
  registerGraphCatalogControllerRoutes(app);
  registerRelationshipArtifactGatewayRoutes(app);
  registerRelationshipHistoricalReadRoutes(app);
  registerRelationshipPublicationRoutes(app);
  registerChatActionJobRoutes(app);
  registerChatActionRunRoute(app, { queryDocs, readDoc, replaceDoc, execute: createChatActionExecutor(handleCheckpoint) });
  registerWebhookRoutes(app);

  app.setNotFoundHandler(async (_req, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message:
        'Route not found. Known routes: GET /health, POST /mcp, POST /heygen/pair, GET /oauth/authorize, POST /oauth/token, GET /.well-known/oauth-authorization-server, POST /admin/revoke.',
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
      const response = publicErrorResponse(error);
      await reply.code(response.statusCode).send(response.body);
    }
  });

  // Load the durable token-revocation blocklist into memory BEFORE accepting requests, so a leaked
  // token that was revoked stays rejected across restarts / blue-green redeploys (the blocklist is
  // persisted in the configured state backend). A failed initial read keeps only static-token auth
  // closed; short-lived OAuth remains available so the process can start and expose diagnostics.
  const startup = await initializeStartup(env, {
    loadRevocations,
    getRevocationStoreStatus,
    startRevocationReloader,
    startDeindexResweepReloader,
    runCloudBrowserPolling,
    onRevocationUnavailable: (status) => {
      logger.error(
        { type: 'revocation_store_unavailable', state: status.state },
        'static-token authentication is closed until the durable revocation state loads',
      );
    },
  });
  const { revokedCount } = startup;
  if (revokedCount > 0) {
    logger.warn({ type: 'revocations_loaded', count: revokedCount }, 'loaded durable token revocations at boot');
  }

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

  const stopCloudBrowserPolling = startPostListenWorkers(env, { runCloudBrowserPolling });
  const shutdown = async (signal: string): Promise<void> => {
    stopCloudBrowserPolling();
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
