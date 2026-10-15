import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface DaytonaViewerConnection { signed_url: string; expires_at: number }
export interface DaytonaViewerService {
  // Implementations must enforce one-time exchange, original ticket/session expiry,
  // OAuth principal/profile ownership, and a shared effect fence for all operations.
  exchange(token: string): Promise<DaytonaViewerConnection>;
  resume(token: string): Promise<DaytonaViewerConnection>;
  // True means the exact owned viewer's existing VNC clients were positively
  // disconnected BEFORE verification/checkpoint or releasing automation. Merely
  // expiring a URL or closing a logical mission does not satisfy this receipt.
  complete(token: string): Promise<{ status: 'saved'; human_input_revoked: true }>;
  expire(token: string): Promise<{ status: 'expired'; human_input_revoked: true }>;
}
export interface DaytonaViewerOptions {
  previewDomain: string;
  previewPort: number;
  viewerPath: string;
  now?: () => number;
}

const ORIGIN = 'https://mcp.otchealth.app';
const COOKIE = '__Host-otc-daytona-login';
const SELECTOR = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROUTE = '/browser/daytona';

function headers(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff').header('access-control-allow-origin', ORIGIN);
}

function allowed(request: FastifyRequest): boolean {
  return request.headers.origin === ORIGIN
    && (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin');
}

function selector(token: string): string { return createHash('sha256').update(token).digest('hex').slice(0, 32); }

function field(body: unknown, name: string, pattern: RegExp): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) return;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function cookieToken(request: FastifyRequest, id: string): string | undefined {
  const prefix = `${COOKIE}-${id}=`;
  const matches = (request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
  const token = matches.length === 1 ? matches[0]!.slice(prefix.length) : '';
  return TOKEN.test(token) && selector(token) === id ? token : undefined;
}

function validatedView(result: DaytonaViewerConnection, options: DaytonaViewerOptions): DaytonaViewerConnection {
  const now = (options.now ?? Date.now)();
  if (!result || typeof result.signed_url !== 'string' || !Number.isSafeInteger(result.expires_at)
    || result.expires_at <= now || result.expires_at > now + 600_000) throw new Error('invalid_viewer');
  const url = new URL(result.signed_url);
  const suffix = `.${options.previewDomain}`;
  const label = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : '';
  // Signed URLs are minted server-side for this single VNC port. Never accept
  // standard preview headers/tokens, toolbox links, arbitrary URLs or secrets.
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !new RegExp(`^${options.previewPort}-[a-z0-9-]+$`).test(label)
    || url.pathname !== options.viewerPath) throw new Error('invalid_viewer');
  const values: Record<string, readonly string[]> = { autoconnect: ['true', '1'], resize: ['scale', 'remote', 'off'], path: ['websockify'] };
  for (const [key, value] of url.searchParams) {
    if (!values[key]?.includes(value) || url.searchParams.getAll(key).length !== 1) throw new Error('invalid_viewer');
  }
  return { signed_url: url.href, expires_at: result.expires_at };
}

/** Private native-desktop viewer. Trusted adapter, not the browser, owns all leases/effect fences. */
export function registerDaytonaViewerRoutes(app: FastifyInstance, runtime: () => DaytonaViewerService, options: DaytonaViewerOptions): void {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(options.previewDomain)
    || !Number.isInteger(options.previewPort) || options.previewPort < 1 || options.previewPort > 65535
    || !/^\/[A-Za-z0-9_./-]+$/.test(options.viewerPath) || options.viewerPath.includes('..')) throw new Error('invalid_daytona_viewer_configuration');

  app.get(ROUTE, async (_request, reply) => {
    headers(reply);
    const nonce = randomBytes(18).toString('base64');
    reply.header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src https://*.${options.previewDomain}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()')
      .type('text/html; charset=utf-8');
    return reply.send(page(nonce));
  });

  const routeOptions = { bodyLimit: 256, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post(`${ROUTE}/exchange`, routeOptions, async (request, reply) => {
    headers(reply);
    if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
    const token = field(request.body, 'token', TOKEN);
    if (!token) return reply.code(400).send({ error: 'invalid_login_link' });
    try {
      const view = validatedView(await runtime().exchange(token), options);
      const id = selector(token);
      const maxAge = Math.floor((view.expires_at - (options.now ?? Date.now)()) / 1000);
      if (maxAge < 1) throw new Error('expired_viewer');
      reply.header('set-cookie', `${COOKIE}-${id}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
      return reply.send({ ...view, handoff_id: id });
    } catch { return reply.code(409).send({ error: 'viewer_unavailable' }); }
  });

  for (const action of ['resume', 'complete', 'expire'] as const) {
    app.post(`${ROUTE}/${action}`, routeOptions, async (request, reply) => {
      headers(reply);
      if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
      const id = field(request.body, 'handoff_id', SELECTOR);
      const token = id && cookieToken(request, id);
      if (!id || !token) return reply.code(400).send({ error: 'invalid_login_session' });
      try {
        if (action === 'resume') return reply.send({ ...validatedView(await runtime().resume(token), options), handoff_id: id });
        const result = await runtime()[action](token);
        const status = action === 'complete' ? 'saved' : 'expired';
        if (result?.human_input_revoked !== true || result.status !== status) throw new Error('human_input_not_revoked');
        reply.header('set-cookie', `${COOKIE}-${id}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
        return reply.send({ status, human_input_revoked: true });
      } catch { return reply.code(409).send({ error: 'viewer_operation_not_confirmed' }); }
    });
  }
}

function page(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your browser</title>
<style nonce="${nonce}">body{margin:0;background:#111827;color:#f9fafb;font:16px system-ui}header{padding:16px}p{margin:8px 0}iframe{display:block;width:100%;height:calc(100vh - 180px);min-height:400px;border:0;background:#000}button{padding:10px 16px;margin:8px 8px 0 0}button:disabled{opacity:.5}</style></head><body>
<header><h1>Connect your browser</h1><p>Sign in inside the remote Chrome window. Open the signed-in workspace and confirm the correct account, then click Done to release control.</p><p id="status" role="status">Opening secure desktop…</p><button id="done" disabled>Done — release control</button><button id="cancel" disabled>Cancel</button></header>
<iframe id="viewer" title="Private remote browser desktop" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" hidden></iframe>
<script nonce="${nonce}">(() => {
'use strict';
const root='${ROUTE}', key='otc-daytona-handoff', status=document.getElementById('status'), viewer=document.getElementById('viewer'), done=document.getElementById('done'), cancel=document.getElementById('cancel');
let handoffId='', terminal=false, timer;
const storage={get:()=>{try{return sessionStorage.getItem(key)||'';}catch{return '';}},set:value=>{try{sessionStorage.setItem(key,value);}catch{}},clear:()=>{try{sessionStorage.removeItem(key);}catch{}}};
async function post(action,body){let response;try{response=await fetch(root+'/'+action,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}catch{throw new Error(action==='resume'?'resume_retryable':'unavailable');}if(!response.ok)throw new Error(action==='resume'&&(response.status===408||response.status===429||(response.status>=500&&response.status<=599))?'resume_retryable':'unavailable');return response.json();}
async function finish(action){if(terminal||!handoffId)return;terminal=true;done.disabled=true;cancel.disabled=true;clearTimeout(timer);storage.clear();viewer.src='about:blank';viewer.hidden=true;status.textContent='Releasing human control…';try{const result=await post(action,{handoff_id:handoffId});if(result.human_input_revoked!==true)throw new Error('unconfirmed');status.textContent=action==='complete'?'Signed-in browser saved. Control released.':'Desktop handoff ended. Control released.';}catch{status.textContent='Control release could not be confirmed. Do not retry Done; ask your agent to check the existing session.';}}
done.addEventListener('click',()=>finish('complete'));cancel.addEventListener('click',()=>finish('expire'));
(async()=>{
  const fragment=new URLSearchParams(window.location.hash.slice(1));
  const token=fragment.get('token');
  history.replaceState(null,'',window.location.pathname);
  try{
    let result;
    if(token){
      if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error('invalid');
      result=await post('exchange',{token});
    }else{
      handoffId=storage.get();
      if(!/^[a-f0-9]{32}$/.test(handoffId))throw new Error('invalid');
      result=await post('resume',{handoff_id:handoffId});
    }
    if(!/^[a-f0-9]{32}$/.test(result.handoff_id)||typeof result.signed_url!=='string'||!Number.isSafeInteger(result.expires_at)||result.expires_at<=Date.now())throw new Error('invalid');
    handoffId=result.handoff_id;storage.set(handoffId);viewer.src=result.signed_url;viewer.hidden=false;done.disabled=false;cancel.disabled=false;
    status.textContent='Connect in the desktop window if prompted. Confirm the correct signed-in account before Done.';
    // Best effort only: the provider must also revoke expired grants when the
    // tab is offline/closed. The original cookie/ticket lifetime is not extended.
    timer=setTimeout(()=>finish('expire'),Math.max(0,Math.min(result.expires_at-Date.now()-1000,600000)));
  }catch(error){
    terminal=true;viewer.src='about:blank';viewer.hidden=true;
    if(error?.message==='resume_retryable'){
      status.textContent='The secure desktop could not be reached. Check your connection, then reload this page to resume the same handoff before its original expiry.';
    }else{
      storage.clear();status.textContent='This desktop handoff is expired or unavailable. Ask your agent for a new secure link.';
    }
  }
})();
})();</script></body></html>`;
}
