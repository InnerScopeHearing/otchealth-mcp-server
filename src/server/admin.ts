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
    if (state.durability === 'failed') {
      logger.error(
        {
          type: 'admin_revoke_persist_failed',
          revoked_token_hash: state.revoked_token_hash,
          revoked_at: state.revoked_at,
          explicit_token: Boolean(parsed.data.token),
          ip: request.ip,
        },
        'token blocked on this replica but durable revocation failed',
      );
      return reply.code(503).send({
        status: 'revocation_not_persisted',
        locally_blocked: true,
        persisted: false,
        revoked_at: state.revoked_at,
        revoked_token_hash: state.revoked_token_hash,
        reason: state.revoked_reason,
        retry_required: true,
        note:
          'This replica rejects the token, but the durable write failed. Retry until persisted=true; ' +
          'other replicas and future restarts are not confirmed protected.',
      });
    }
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
      status: state.durability === 'durable' ? 'revoked' : 'revoked_memory_only',
      persisted: state.persisted,
      revoked_at: state.revoked_at,
      revoked_token_hash: state.revoked_token_hash,
      reason: state.revoked_reason,
      note: state.durability === 'durable'
        ? 'Requests using this exact token now return 401. persisted=true confirms the revocation ' +
          'will be reloaded after restart and reconciled to other replicas.'
        : 'Requests using this exact token now return 401 in this memory-only runtime. No durable ' +
          'revocation backend is configured.',
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
    const result = await clearRevocation();
    if (!result.cleared) {
      logger.warn(
        { type: 'admin_revoke_clear_refused', ip: request.ip, ...result },
        'durable revocation clear refused',
      );
      return reply.code(409).send({
        ...result,
        note: 'Durable clear is disabled until a versioned tombstone protocol can converge every replica.',
      });
    }
    logger.warn(
      { type: 'admin_revoke_cleared', ip: request.ip },
      'memory-only revocation cleared via /admin/clear-revoke',
    );
    return reply.code(200).send(result);
  });
}
