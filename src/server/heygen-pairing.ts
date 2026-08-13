/**
 * One-time HeyGen credential handoff.
 *
 * POST /heygen/pair accepts a short-lived pair id plus the official CLI credentials JSON in a
 * base64 header. The pair id is atomically moved unused -> claiming by Cosmos ETag BEFORE the header
 * is decoded or any HeyGen request is sent. The header is never logged or returned.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  claimHeyGenPairing,
  defaultHeyGenBrokerDeps,
  finishHeyGenPairing,
  HeyGenBrokerError,
  parseOfficialCredentialsHeader,
  persistPairedHeyGenToken,
  requireHeyGenSigningSecret,
  verifyHeyGenSubscription,
  type HeyGenBrokerDeps,
} from '../tools/heygen/broker.js';

const PairBodySchema = z
  .object({
    pair_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export interface HeyGenPairingHttpResult {
  statusCode: number;
  body: {
    status?: 'paired';
    error?: string;
    message: string;
  };
}

function safePairingFailure(error: unknown): HeyGenBrokerError {
  if (error instanceof HeyGenBrokerError) return error;
  return new HeyGenBrokerError(
    'heygen_pairing_failed',
    'HeyGen pairing failed. Start a new pairing session and try again.',
    502,
  );
}

/** Exported dependency-injected route core for hermetic tests; it never performs live calls in tests. */
export async function handleHeyGenPairing(
  pairId: string,
  credentialsHeader: string | undefined,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): Promise<HeyGenPairingHttpResult> {
  // LOAD-BEARING ORDER: consume first. Even malformed/malicious credential input burns the one-time
  // pair, so a captured pair id can never be probed repeatedly.
  const claim = await claimHeyGenPairing(pairId, deps);
  try {
    requireHeyGenSigningSecret(deps);
    if (!credentialsHeader) {
      throw new HeyGenBrokerError(
        'credentials_header_missing',
        'Header x-heygen-oauth-credentials is required.',
        400,
      );
    }
    const tokenState = parseOfficialCredentialsHeader(credentialsHeader);
    const userResponse = await verifyHeyGenSubscription(tokenState.accessToken, deps);
    await persistPairedHeyGenToken(tokenState, userResponse, deps);
    await finishHeyGenPairing(claim, 'used', undefined, deps);
    return {
      statusCode: 200,
      body: {
        status: 'paired',
        message: 'HeyGen OAuth pairing completed. Credential material was encrypted before storage.',
      },
    };
  } catch (error) {
    const safe = safePairingFailure(error);
    try {
      await finishHeyGenPairing(claim, 'failed', safe.code, deps);
    } catch {
      // The pair was already consumed as `claiming`; never weaken the primary sanitized failure by
      // attaching a Cosmos body or credential-bearing error from best-effort status finalization.
    }
    throw safe;
  }
}

export function registerHeyGenPairingRoute(
  app: FastifyInstance,
  deps: HeyGenBrokerDeps = defaultHeyGenBrokerDeps,
): void {
  app.post(
    '/heygen/pair',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const body = PairBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: 'invalid_input',
          message: 'Body must be exactly {"pair_id":"<43-character pairing id>"}.',
        });
      }
      const rawHeader = request.headers['x-heygen-oauth-credentials'];
      const credentialsHeader = typeof rawHeader === 'string' ? rawHeader : undefined;
      try {
        const result = await handleHeyGenPairing(body.data.pair_id, credentialsHeader, deps);
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        const safe = safePairingFailure(error);
        return reply.code(safe.httpStatus).send({ error: safe.code, message: safe.message });
      }
    },
  );
}
