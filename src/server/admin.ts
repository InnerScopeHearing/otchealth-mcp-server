/**
 * POST /admin/revoke — kill-switch per ADR-001 Section 6.
 *
 * Auth: separate ADMIN_REVOKE_TOKEN bearer (NOT the connector token).
 * Effect: marks a token as revoked in an in-memory runtime override store.
 *         Subsequent bearer-auth checks reject that exact token, even though
 *         its underlying secret/signing key is unchanged. Process restart
 *         clears the revocation — for permanent lockout of a leaked static
 *         token, rotate its env var; for a leaked OAuth-issued JWT, rotate
 *         OAUTH_TOKEN_SIGNING_SECRET (fleet-wide blast radius - invalidates
 *         every active session, use deliberately).
 *
 * Body: { "reason": "<3-500 chars>", "token"?: "<raw bearer token to revoke>" }
 *       token is OPTIONAL and defaults to PERPLEXITY_CONNECTOR_TOKEN for
 *       backward compatibility with the original kill-switch behavior. Pass
 *       an explicit token (e.g. a leaked OAuth JWT found in git history) to
 *       revoke that specific credential instead, without touching anything
 *       else's active session.
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
    token: z.string().min(16).max(4096).optional(),
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
          'Body must be { "reason": "<3-500 chars>", "token"?: "<raw bearer token>" }. ' +
          'token defaults to PERPLEXITY_CONNECTOR_TOKEN if omitted.',
        issues: parsed.error.issues,
      });
    }
    const targetToken = parsed.data.token ?? env.PERPLEXITY_CONNECTOR_TOKEN;
    const state = await revokeToken(targetToken, parsed.data.reason);
    logger.warn(
      {
        type: 'admin_revoke_applied',
        revoked_token_hash: state.revoked_token_hash,
        revoked_at: state.revoked_at,
        reason: state.revoked_reason,
        explicit_token: Boolean(parsed.data.token),
        ip: request.ip,
      },
      'token revoked via /admin/revoke',
    );
    return reply.code(200).send({
      status: 'revoked',
      revoked_at: state.revoked_at,
      revoked_token_hash: state.revoked_token_hash,
      reason: state.revoked_reason,
      note:
        'Requests using this exact token now return 401. The revocation is DURABLE (persisted to ' +
        'Cosmos and reloaded into memory on restart/redeploy), so it survives deploys until the token ' +
        'expires. To invalidate EVERY issued JWT at once (not just this one), rotate ' +
        'OAUTH_TOKEN_SIGNING_SECRET instead.',
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
    await clearRevocation();
    logger.warn(
      { type: 'admin_revoke_cleared', ip: request.ip },
      'revocation cleared via /admin/clear-revoke',
    );
    return reply.code(200).send({ status: 'cleared' });
  });
}
