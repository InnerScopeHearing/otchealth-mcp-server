/**
 * OAuth 2.0 endpoints for MCP server authentication.
 * Implements the authorization code flow (with PKCE support) so that
 * MCP clients like Hyperagent can connect via standard OAuth.
 *
 * Flow:
 * 1. Client redirects user to GET /oauth/authorize with client_id, redirect_uri, state, code_challenge
 * 2. Server validates client_id and redirects back with an authorization code
 * 3. Client exchanges code at POST /oauth/token for an access_token
 * 4. Client uses access_token as Bearer in POST /mcp calls
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes, createHash } from 'crypto';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

// In-memory authorization code store (short-lived, cleared on restart)
const authCodes = new Map<string, {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}>();

// Clean up expired codes every 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) authCodes.delete(code);
  }
}, 60_000);

function generateCode(): string {
  return randomBytes(32).toString('hex');
}

function verifyCodeChallenge(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = createHash('sha256').update(verifier).digest('base64url');
    return hash === challenge;
  }
  // plain method
  return verifier === challenge;
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  // OAuth metadata discovery
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const baseUrl = `${req.protocol}://${req.hostname}`;
    return reply.send({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });
  });

  // Authorization endpoint
  app.get('/oauth/authorize', async (req, reply) => {
    const query = req.query as Record<string, string>;
    const {
      client_id,
      redirect_uri,
      response_type,
      state,
      code_challenge,
      code_challenge_method,
    } = query;

    // Validate response_type
    if (response_type !== 'code') {
      return reply.status(400).send({ error: 'unsupported_response_type' });
    }

    // Validate client_id matches our connector token
    if (!client_id || client_id !== env.PERPLEXITY_CONNECTOR_TOKEN) {
      return reply.status(400).send({ error: 'invalid_client' });
    }

    // Validate redirect_uri is present
    if (!redirect_uri) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'redirect_uri required' });
    }

    // Generate authorization code
    const code = generateCode();
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method ?? 'plain',
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    });

    // Redirect back with code
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);

    return reply.redirect(302, url.toString());
  });

  // Token endpoint
  app.post('/oauth/token', async (req, reply) => {
    const body = typeof req.body === 'string'
      ? Object.fromEntries(new URLSearchParams(req.body))
      : (req.body as Record<string, string>);

    const {
      grant_type,
      code,
      redirect_uri,
      client_id,
      code_verifier,
    } = body;

    if (grant_type !== 'authorization_code') {
      return reply.status(400).send({ error: 'unsupported_grant_type' });
    }

    if (!code) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'code required' });
    }

    // Look up the authorization code
    const authCode = authCodes.get(code);
    if (!authCode) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired or invalid' });
    }

    // Delete the code (one-time use)
    authCodes.delete(code);

    // Check expiry
    if (authCode.expiresAt < Date.now()) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired' });
    }

    // Validate redirect_uri matches
    if (redirect_uri && redirect_uri !== authCode.redirectUri) {
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // Validate client_id if provided
    if (client_id && client_id !== authCode.clientId) {
      return reply.status(400).send({ error: 'invalid_client' });
    }

    // Validate PKCE code_verifier if code_challenge was provided
    if (authCode.codeChallenge) {
      if (!code_verifier) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'code_verifier required' });
      }
      if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod ?? 'plain')) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'code_verifier invalid' });
      }
    }

    // Return the access token (our connector token IS the access token)
    reply.header('Cache-Control', 'no-store');
    return reply.send({
      access_token: env.PERPLEXITY_CONNECTOR_TOKEN,
      token_type: 'Bearer',
      expires_in: 86400 * 365, // effectively never expires (rotate manually)
    });
  });
}
