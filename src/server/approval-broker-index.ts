import '../instrument.js';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { logger } from '../audit/logger.js';
import { registerHeyGenApprovalBrokerRoutes } from './heygen-approval-broker.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid.');
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true, disableRequestLogging: true });
  await app.register(rateLimit, { global: true, max: 30, timeWindow: '1 minute', allowList: (req) => req.url === '/health' });
  registerHeyGenApprovalBrokerRoutes(app);
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler(async (error: unknown, _request, reply) => {
    logger.error({ type: 'approval_broker_error', err: (error as Error).message }, 'approval broker error');
    if (!reply.sent) await reply.code(500).send({ error: 'internal_error' });
  });
  const address = await app.listen({ port, host: '0.0.0.0' });
  logger.info({ type: 'approval_broker_started', address, port }, 'OTCHealth approval broker listening');
}

main().catch((error: unknown) => {
  console.error('[fatal]', (error as Error).message);
  process.exit(1);
});
