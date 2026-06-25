import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadEnv } from '../config/env.js';
import { hashToken, logger } from '../audit/logger.js';
import { isRevoked } from './revocation-store.js';
import { isValidIssuedAccessToken } from '../server/oauth.js';

const env = loadEnv();

export interface AuthContext {
  caller_hash: string;
  raw_token: string;
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validates a bearer against PERPLEXITY_CONNECTOR_TOKEN. On success returns
 * the AuthContext (with SHA256 caller hash). On failure returns null and the
 * caller is responsible for sending 401. Never logs the raw token.
 */
export function validateBearer(authHeader: string | undefined): AuthContext | null {
  const token = extractBearer(authHeader);
  if (!token) return null;
  if (isRevoked(token)) {
    logger.warn(
      { type: 'auth_revoked', caller_hash: hashToken(token) },
      'rejected revoked connector token',
    );
    return null;
  }
  // Accept EITHER a real issued OAuth 2.1 access token (HS256 JWT) OR the static connector token
  // (back-compat for CLI/curl during the cutover). The static token is rotate-before-launch.
  const ok = isValidIssuedAccessToken(token) || safeEqual(token, env.PERPLEXITY_CONNECTOR_TOKEN);
  if (!ok) return null;
  return { caller_hash: hashToken(token), raw_token: token };
}

export function validateAdminToken(authHeader: string | undefined): boolean {
  const token = extractBearer(authHeader);
  if (!token) return false;
  return safeEqual(token, env.ADMIN_REVOKE_TOKEN);
}

/** Fastify pre-handler enforcing connector-bearer auth on a route. */
export async function requireConnectorAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | undefined> {
  const ctx = validateBearer(request.headers['authorization']);
  if (!ctx) {
    logger.warn(
      {
        type: 'auth_rejected',
        route: request.routeOptions?.url ?? request.url,
        ip: request.ip,
      },
      'connector auth rejected',
    );
    await reply.code(401).send({
      error: 'unauthorized',
      message:
        'Missing or invalid bearer token. Provide Authorization: Bearer <PERPLEXITY_CONNECTOR_TOKEN>.',
    });
    return undefined;
  }
  (request as FastifyRequest & { authContext?: AuthContext }).authContext = ctx;
  return ctx;
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}
