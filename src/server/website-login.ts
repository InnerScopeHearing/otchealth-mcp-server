import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebsiteLoginService } from '../tools/browser-cloud/website-login-service.js';
import { registerWebsiteLoginPage } from './intercom-login-page.js';

const ORIGIN = 'https://mcp.otchealth.app';
const COOKIE = '__Host-otc-website-login';

function headers(reply: FastifyReply): void {
  reply
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header('access-control-allow-origin', ORIGIN);
}

function allowed(request: FastifyRequest): boolean {
  return request.headers.origin === ORIGIN
    && (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin');
}

function handoffFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

function tokenFromCookie(request: FastifyRequest, handoffId: string): string | undefined {
  const cookie = `${COOKIE}-${handoffId}`;
  const matches = (request.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookie}=`));
  const token = matches.length === 1 ? matches[0]!.slice(cookie.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) && handoffFromToken(token) === handoffId ? token : undefined;
}

/** Website login uses a separate ticket/cookie namespace from the Intercom workflow. */
export function registerWebsiteLoginRoutes(app: FastifyInstance, runtime: () => WebsiteLoginService): void {
  registerWebsiteLoginPage(app);

  app.post('/browser/connect/exchange', { bodyLimit: 256, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    headers(reply);
    if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
    const body = request.body as { token?: unknown } | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) {
      return reply.code(400).send({ error: 'invalid_login_link' });
    }
    try {
      const result = await runtime().exchange(body.token);
      const handoffId = handoffFromToken(body.token);
      reply.header('set-cookie', `${COOKIE}-${handoffId}=${body.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`);
      return reply.send({ ...result, handoff_id: handoffId });
    } catch {
      return reply.code(409).send({ error: 'login_link_expired_or_unavailable' });
    }
  });

  app.post('/browser/connect/complete', { bodyLimit: 256, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    headers(reply);
    if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
    const body = request.body as { handoff_id?: unknown } | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.handoff_id !== 'string' || !/^[a-f0-9]{32}$/.test(body.handoff_id)) {
      return reply.code(400).send({ error: 'invalid_login_session' });
    }
    const token = tokenFromCookie(request, body.handoff_id);
    if (!token) return reply.code(400).send({ error: 'invalid_login_session' });
    try {
      const result = await runtime().complete(token);
      reply.header('set-cookie', `${COOKIE}-${body.handoff_id}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return reply.send(result);
    } catch {
      return reply.code(409).send({ error: 'website_sign_in_not_confirmed' });
    }
  });
}
