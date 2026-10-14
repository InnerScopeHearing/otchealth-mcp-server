import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { registerIntercomAwsSetupPage } from './intercom-aws-setup-page.js';
import { registerIntercomLoginPage } from './intercom-login-page.js';
import type { IntercomLoginService } from '../tools/browser-cloud/intercom-login-service.js';

const ORIGIN = 'https://mcp.otchealth.app';
const COOKIE = '__Host-otc-intercom-login';
function headers(reply: FastifyReply): void {
  reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-content-type-options','nosniff').header('access-control-allow-origin',ORIGIN);
}
function allowed(request: FastifyRequest): boolean {
  return request.headers.origin === ORIGIN && (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin');
}
function tokenFromCookie(request: FastifyRequest): string | undefined {
  const parts = (request.headers.cookie || '').split(';').map(v=>v.trim()).filter(v=>v.startsWith(`${COOKIE}=`));
  const token = parts.length === 1 ? parts[0]!.slice(COOKIE.length+1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export function registerIntercomLoginRoutes(app: FastifyInstance, runtime: () => IntercomLoginService): void {
  registerIntercomLoginPage(app);
  registerIntercomAwsSetupPage(app);
  app.post('/browser/login/exchange', { bodyLimit: 256, config: { rateLimit: { max: 10, timeWindow:'1 minute' } } }, async (request, reply) => {
    headers(reply);
    if (!allowed(request)) return reply.code(403).send({error:'same_origin_required'});
    const body = request.body as {token?:unknown} | undefined;
    if (!body || Object.keys(body).length !== 1 || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) return reply.code(400).send({error:'invalid_login_link'});
    try {
      const result = await runtime().exchange(body.token);
      reply.header('set-cookie',`${COOKIE}=${body.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`);
      return reply.send(result);
    } catch { return reply.code(409).send({error:'login_link_expired_or_unavailable'}); }
  });
  app.post('/browser/login/complete', { bodyLimit: 256, config: { rateLimit: { max: 10, timeWindow:'1 minute' } } }, async (request, reply) => {
    headers(reply);
    if (!allowed(request)) return reply.code(403).send({error:'same_origin_required'});
    const token = tokenFromCookie(request);
    if (!token || request.body !== undefined) return reply.code(400).send({error:'invalid_login_session'});
    try {
      const result = await runtime().complete(token);
      reply.header('set-cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      return reply.send(result);
    } catch { return reply.code(409).send({error:'company_settings_sign_in_not_confirmed'}); }
  });
}
