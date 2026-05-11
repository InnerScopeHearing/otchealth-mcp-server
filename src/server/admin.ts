/**
 * POST /admin/revoke — kill-switch per ADR-001 Section 6.
 *
 * Auth: separate ADMIN_REVOKE_TOKEN bearer (NOT the connector token).
 * Effect: marks the current PERPLEXITY_CONNECTOR_TOKEN as revoked in an
 *         in-memory runtime override store. Subsequent bearer-auth checks
 *         from Perplexity reject the token, even though the env var is
 *         unchanged. Process restart clears the revocation — for permanent
 *         lockout, rotate the env var.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { validateAdminToken } from '../auth/bearer.js';
import { revokeToken, getRevocationState, clearRevocation } from '../auth/revocation-store.js';
import { logger } from '../audit/logger.js';

const env = loadEnv();

const RevokeBody = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();

export function registerAdmin(app: FastifyInstance): void {
  app.post('/admin/revoke', async (request, reply) => {
    if (!validateAdminToken(request.headers['authorization'])) {
      logger.warn(
        { type: 'admin_revoke_unauthorized', ip: request.ip },
        'admin revoke rejected',
      );
      return reply.code(401).send({
        error: 'unauthorized',
        message:
          'Missing or invalid admin token. Provide Authorization: Bearer <ADMIN_REVOKE_TOKEN>.',
      });
    }
    const parsed = RevokeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message:
          'Body must be { "reason": "<3-500 chars>" } describing why the token is being revoked.',
        issues: parsed.error.issues,
      });
    }
    const state = revokeToken(env.PERPLEXITY_CONNECTOR_TOKEN, parsed.data.reason);
    logger.warn(
      {
        type: 'admin_revoke_applied',
        revoked_token_hash: state.revoked_token_hash,
        revoked_at: state.revoked_at,
        reason: state.revoked_reason,
        ip: request.ip,
      },
      'PERPLEXITY_CONNECTOR_TOKEN revoked via /admin/revoke',
    );
    return reply.code(200).send({
      status: 'revoked',
      revoked_at: state.revoked_at,
      revoked_token_hash: state.revoked_token_hash,
      reason: state.revoked_reason,
      note:
        'Connector requests using this token will now return 401. Rotate PERPLEXITY_CONNECTOR_TOKEN in Railway and restart for permanent lockout.',
    });
  });

  app.get('/admin/revoke', async (request, reply) => {
    if (!validateAdminToken(request.headers['authorization'])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.code(200).send(getRevocationState());
  });

  app.post('/admin/clear-revoke', async (request, reply) => {
    if (!validateAdminToken(request.headers['authorization'])) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    clearRevocation();
    logger.warn(
      { type: 'admin_revoke_cleared', ip: request.ip },
      'revocation cleared via /admin/clear-revoke',
    );
    return reply.code(200).send({ status: 'cleared' });
  });
}
