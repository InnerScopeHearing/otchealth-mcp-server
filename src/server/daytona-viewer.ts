import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger, newCorrelationId } from '../audit/logger.js';

export interface DaytonaViewerConnection { signed_url: string; expires_at: number }
export interface DaytonaViewerDeadlines { handoff_id: string; opening_expires_at: number; mission_expires_at: number; target_label?: 'WeFunder' }
export type DaytonaViewerReason = 'opening_expired' | 'mission_expired' | 'mission_revoked' | 'recovery_state_missing' | 'operation_pending' | 'desktop_unavailable';
export interface DaytonaViewerStatus extends Omit<DaytonaViewerDeadlines, 'handoff_id'> { status: 'ready_for_open' | 'pending' | 'active' | 'saved' | 'expired'; viewer_expires_at?: number; renewal_allowed?: boolean; cleanup_required?: boolean; reason?: DaytonaViewerReason }
export interface DaytonaViewerService {
  prepare(token: string, browserProof: string): Promise<DaytonaViewerDeadlines>;
  exchange(token: string, browserProof?: string): Promise<DaytonaViewerConnection>;
  recover(selector: string, browserProof: string): Promise<DaytonaViewerConnection>;
  openPrepared(selector: string, browserProof: string): Promise<DaytonaViewerConnection>;
  status(selector: string, browserProof: string): Promise<DaytonaViewerStatus>;
  reconcile(selector: string, browserProof: string): Promise<{ status: 'saved'; human_input_revoked: true; checkpoint_saved: true; mission_released: true }>;
  renew(selector: string, browserProof: string): Promise<DaytonaViewerConnection>;
  complete(selector: string, browserProof: string): Promise<{ status: 'saved'; human_input_revoked: true; checkpoint_saved: true; mission_released: true }>;
  expire(selector: string, browserProof: string): Promise<{ status: 'expired'; human_input_revoked: true; mission_released: true }>;
}
export interface DaytonaViewerOptions { previewDomain: string; previewPort: number; viewerPath: string; now?: () => number }

const ORIGIN = 'https://mcp.otchealth.app';
const COOKIE = '__Host-otc-daytona-recovery';
const SELECTOR = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROUTE = '/browser/daytona';

function headers(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff').header('access-control-allow-origin', ORIGIN);
}
function allowed(request: FastifyRequest): boolean {
  return request.headers.origin === ORIGIN && (!request.headers['sec-fetch-site'] || request.headers['sec-fetch-site'] === 'same-origin');
}
function selector(token: string): string { return createHash('sha256').update(token).digest('hex').slice(0, 32); }
function field(body: unknown, name: string, pattern: RegExp): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) return;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}
function proof(request: FastifyRequest): string | undefined {
  const prefix = `${COOKIE}=`;
  const matches = (request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
  const value = matches.length === 1 ? matches[0]!.slice(prefix.length) : '';
  return TOKEN.test(value) ? value : undefined;
}
function validatedView(result: DaytonaViewerConnection, options: DaytonaViewerOptions): DaytonaViewerConnection {
  const now = (options.now ?? Date.now)();
  if (!result || typeof result.signed_url !== 'string' || !Number.isSafeInteger(result.expires_at) || result.expires_at <= now || result.expires_at > now + 600_000) throw new Error('invalid_viewer');
  const url = new URL(result.signed_url), suffix = `.${options.previewDomain}`;
  const label = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : '';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !new RegExp(`^${options.previewPort}-[a-z0-9-]+$`).test(label) || url.pathname !== options.viewerPath) throw new Error('invalid_viewer');
  const values: Record<string, readonly string[]> = { autoconnect: ['true', '1'], resize: ['scale', 'remote', 'off'], path: ['websockify'] };
  for (const [key, value] of url.searchParams) if (!values[key]?.includes(value) || url.searchParams.getAll(key).length !== 1) throw new Error('invalid_viewer');
  url.searchParams.set('autoconnect', 'true');
  url.searchParams.set('resize', 'scale');
  return { signed_url: url.href, expires_at: result.expires_at };
}
function deadlines(value: DaytonaViewerDeadlines, id: string, now: number): DaytonaViewerDeadlines {
  if (!value || value.handoff_id !== id || !Number.isSafeInteger(value.opening_expires_at) || !Number.isSafeInteger(value.mission_expires_at)
    || value.opening_expires_at <= now || value.mission_expires_at < value.opening_expires_at || value.mission_expires_at > now + 86_400_000
    || (value.target_label !== undefined && value.target_label !== 'WeFunder')) throw new Error('invalid_viewer');
  return value;
}
function selected(body: unknown): string | undefined { return field(body, 'handoff_id', SELECTOR); }
function safeReason(error: unknown): DaytonaViewerReason {
  const value = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  return (['opening_expired', 'mission_expired', 'mission_revoked', 'recovery_state_missing', 'operation_pending', 'desktop_unavailable'] as string[]).includes(value) ? value as DaytonaViewerReason : 'desktop_unavailable';
}
function failed(reply: FastifyReply, error: unknown, operation: string, errorCode: 'viewer_unavailable' | 'viewer_operation_not_confirmed' = 'viewer_unavailable') {
  const code = safeReason(error), correlation_id = newCorrelationId();
  logger.warn({ type: 'daytona_viewer_outcome', correlation_id, action: operation, reason: code }, 'Daytona viewer operation failed');
  return reply.code(409).send({ error: errorCode, reason: code, correlation_id });
}

/** Private native-desktop viewer. Trusted adapter owns leases and all provider effects. */
export function registerDaytonaViewerRoutes(app: FastifyInstance, runtime: () => DaytonaViewerService, options: DaytonaViewerOptions): void {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(options.previewDomain) || !Number.isInteger(options.previewPort) || options.previewPort < 1 || options.previewPort > 65535 || !/^\/[A-Za-z0-9_./-]+$/.test(options.viewerPath) || options.viewerPath.includes('..')) throw new Error('invalid_daytona_viewer_configuration');
  app.get(ROUTE, async (_request, reply) => {
    headers(reply);
    const nonce = randomBytes(18).toString('base64');
    reply.header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src https://*.${options.previewDomain}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`)
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()').type('text/html; charset=utf-8');
    return reply.send(page(nonce));
  });
  const routeOptions = { bodyLimit: 256, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post(`${ROUTE}/bootstrap`, routeOptions, async (request, reply) => {
    headers(reply); if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length !== 0) return reply.code(400).send({ error: 'invalid_bootstrap' });
    if (proof(request)) return reply.send({ ready: true });
    const browserProof = randomBytes(32).toString('base64url');
    reply.header('set-cookie', `${COOKIE}=${browserProof}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
    return reply.send({ ready: false });
  });
  app.post(`${ROUTE}/prepare`, routeOptions, async (request, reply) => {
    headers(reply); if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
    const token = field(request.body, 'token', TOKEN), browserProof = proof(request);
    if (!token || !browserProof) return reply.code(400).send({ error: 'invalid_login_session' });
    try { const id = selector(token), value = deadlines(await runtime().prepare(token, browserProof), id, (options.now ?? Date.now)()); return reply.send(value); }
    catch (error) { return failed(reply, error, 'prepare'); }
  });
  app.post(`${ROUTE}/exchange`, routeOptions, async (request, reply) => {
    headers(reply); if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
    const token = field(request.body, 'token', TOKEN), browserProof = proof(request);
    if (!token || !browserProof) return reply.code(400).send({ error: 'invalid_login_session' });
    try { return reply.send({ ...validatedView(await runtime().exchange(token, browserProof), options), handoff_id: selector(token) }); }
    catch (error) { return failed(reply, error, 'exchange'); }
  });
  for (const action of ['open', 'recover', 'status', 'reconcile', 'renew', 'complete', 'expire'] as const) {
    app.post(`${ROUTE}/${action}`, routeOptions, async (request, reply) => {
      headers(reply); if (!allowed(request)) return reply.code(403).send({ error: 'same_origin_required' });
      const id = selected(request.body), browserProof = proof(request);
      if (!id || !browserProof) return reply.code(400).send({ error: 'invalid_login_session' });
      try {
        if (action === 'status') {
          const value = await runtime().status(id, browserProof);
          if (!['ready_for_open', 'pending', 'active', 'saved', 'expired'].includes(value.status) || !Number.isSafeInteger(value.opening_expires_at) || !Number.isSafeInteger(value.mission_expires_at)
            || (value.viewer_expires_at !== undefined && !Number.isSafeInteger(value.viewer_expires_at)) || (value.renewal_allowed !== undefined && typeof value.renewal_allowed !== 'boolean')
            || (value.cleanup_required !== undefined && typeof value.cleanup_required !== 'boolean') || (value.target_label !== undefined && value.target_label !== 'WeFunder')) throw new Error('invalid_status');
          return reply.send(value);
        }
        if (action === 'open' || action === 'recover' || action === 'renew') return reply.send({ ...validatedView(await (action === 'open' ? runtime().openPrepared(id, browserProof) : runtime()[action](id, browserProof)), options), handoff_id: id });
        if (action === 'complete') {
          const result = await runtime().complete(id, browserProof);
          if (result.status !== 'saved' || result.human_input_revoked !== true || result.checkpoint_saved !== true || result.mission_released !== true) throw new Error('incomplete_receipt');
          return reply.send(result);
        }
        if (action === 'reconcile') {
          const result = await runtime().reconcile(id, browserProof);
          if (result.status !== 'saved' || result.human_input_revoked !== true || result.checkpoint_saved !== true || result.mission_released !== true) throw new Error('incomplete_receipt');
          return reply.send(result);
        }
        const result = await runtime().expire(id, browserProof);
        if (result.status !== 'expired' || result.human_input_revoked !== true || result.mission_released !== true) throw new Error('incomplete_receipt');
        return reply.send(result);
      } catch (error) { return failed(reply, error, action, 'viewer_operation_not_confirmed'); }
    });
  }
}

function page(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your browser</title>
<style nonce="${nonce}">html,body{height:100%;min-height:0}body{margin:0;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden;background:#111827;color:#f9fafb;font:16px system-ui}header{flex:0 1 auto;max-height:45%;overflow:auto;box-sizing:border-box;padding:clamp(6px,2vh,16px)}h1{font-size:clamp(1rem,4vw,1.4rem);margin:0 0 4px}p{margin:4px 0}iframe{display:block;flex:1 1 auto;min-height:0;width:100%;height:auto;border:0;background:#000}button{padding:8px 12px;margin:4px 6px 0 0;max-width:100%}button:disabled{opacity:.5}[hidden]{display:none!important}</style></head><body>
<header><h1 id="targetHeading">Connect your browser</h1><p id="targetInstructions">Sign in inside the remote Chrome window. Open the signed-in workspace and confirm the correct account, then select Done.</p><p id="status" role="status" aria-live="polite" tabindex="-1">Preparing secure desktop…</p><p id="deadlines"></p><button id="done" disabled>Done — save and release control</button><button id="cancel" disabled>Cancel handoff</button><button id="bootstrap" hidden>Check secure browser setup</button><button id="open" hidden>Open prepared desktop</button><button id="recover" hidden>Check or resume this handoff</button><button id="renew" hidden>Renew secure viewing</button><button id="reconcile" hidden>Confirm saved handoff release</button></header>
<iframe id="viewer" title="Private remote browser desktop" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" hidden></iframe>
<script nonce="${nonce}">(() => {
'use strict';
const root='${ROUTE}', key='otc-daytona-handoff', SELECTOR=/^[a-f0-9]{32}$/, status=document.getElementById('status'), deadlinesNode=document.getElementById('deadlines'), targetHeading=document.getElementById('targetHeading'), targetInstructions=document.getElementById('targetInstructions'), viewer=document.getElementById('viewer'), done=document.getElementById('done'), cancel=document.getElementById('cancel'), recover=document.getElementById('recover'), renew=document.getElementById('renew'), openButton=document.getElementById('open'), bootstrapButton=document.getElementById('bootstrap'), reconcileButton=document.getElementById('reconcile');
let handoffId='', pendingToken='', openingDeadline=0, missionDeadline=0, viewerDeadline=0, prepared=false, exchangeAttempted=false, terminal=false, frameTimer, expiryTimer, countdownTimer;
const storage={get:()=>{try{return sessionStorage.getItem(key)||'';}catch{return '';}},set:value=>{try{sessionStorage.setItem(key,value);}catch{}},clear:()=>{try{sessionStorage.removeItem(key);}catch{}}};
function announce(value){status.textContent=value;status.focus();}
function route(value){history.replaceState(null,'',value);}
function query(id){route(window.location.pathname+'?handoff='+encodeURIComponent(id));}
function clearSelection(){storage.clear();route(window.location.pathname);}
async function ensureBrowserProof(){let result=await post('bootstrap',{});if(result.ready!==true)result=await post('bootstrap',{});if(result.ready!==true)throw new Error('cookie_unavailable');}
async function startTicket(){await ensureBrowserProof();bootstrapButton.hidden=true;const plan=await post('prepare',{token:pendingToken});if(plan.handoff_id!==handoffId||!validDeadlines(plan))throw new Error('opening_expired');setTarget(plan.target_label);prepared=true;openingDeadline=plan.opening_expires_at;missionDeadline=plan.mission_expires_at;showDeadlines();exchangeAttempted=true;const token=pendingToken;pendingToken='';openView({...await post('exchange',{token}),handoff_id:handoffId});}
async function post(action,body){let response;try{response=await fetch(root+'/'+action,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{throw new Error('retryable');}if(!response.ok){let code='',correlation='';try{const detail=await response.json();if(['opening_expired','mission_expired','mission_revoked','recovery_state_missing','operation_pending','desktop_unavailable'].includes(detail.reason))code=detail.reason;if(/^[0-9a-f-]{36}$/.test(detail.correlation_id||''))correlation=detail.correlation_id;}catch{}const failure=new Error(code||((response.status===408||response.status===429||response.status>=500)?'retryable':'terminal'));failure.correlationId=correlation;throw failure;}try{return await response.json();}catch{throw new Error('retryable');}}
function withReference(message,error){return /^[0-9a-f-]{36}$/.test(error?.correlationId||'')?message+' Reference: '+error.correlationId+'.':message;}
function validDeadlines(value){return Number.isSafeInteger(value?.opening_expires_at)&&Number.isSafeInteger(value?.mission_expires_at)&&value.opening_expires_at>Date.now()&&value.mission_expires_at>=value.opening_expires_at;}
const reasonText={opening_expired:'The opening link expired before a desktop was opened. Ask your agent for a new secure link.',mission_expired:'The desktop mission expired. Ask your agent for a new secure link.',mission_revoked:'This desktop handoff was revoked. Ask your agent for a new secure link.',recovery_state_missing:'This browser proof is not bound to the handoff. Ask your agent for a new secure link.',operation_pending:'A prior handoff action is still being reconciled. Check status again shortly; do not open another desktop.',desktop_unavailable:'The secure desktop is temporarily unavailable. Check your connection and try the same handoff again.'};
function setTarget(label){if(label==='WeFunder'){targetHeading.textContent='Connect to WeFunder';targetInstructions.textContent='Sign in inside the remote Chrome window. Open the WeFunder workspace and confirm the correct account, then select Done.';}}
function remaining(deadline){const seconds=Math.max(0,Math.ceil((deadline-Date.now())/1000));return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
function showDeadlines(){clearTimeout(countdownTimer);const update=()=>{deadlinesNode.textContent='Opening link expires '+new Date(openingDeadline).toLocaleTimeString()+' ('+remaining(openingDeadline)+' remaining). Desktop mission ends '+new Date(missionDeadline).toLocaleTimeString()+' ('+remaining(missionDeadline)+' remaining).';if(!terminal)countdownTimer=setTimeout(update,1000);};update();}
function clearFrame(){clearTimeout(frameTimer);clearTimeout(expiryTimer);viewer.src='about:blank';viewer.hidden=true;done.disabled=true;cancel.disabled=true;}
function showRecovery(message,terminalFailure=false){clearFrame();announce(message);recover.hidden=terminalFailure;renew.hidden=true;openButton.hidden=true;reconcileButton.hidden=true;if(terminalFailure){terminal=true;clearTimeout(countdownTimer);storage.clear();route(window.location.pathname);}}
function openView(value){if(value.handoff_id!==handoffId||typeof value.signed_url!=='string'||!Number.isSafeInteger(value.expires_at)||value.expires_at<=Date.now())throw new Error('invalid');viewerDeadline=value.expires_at;viewer.hidden=false;viewer.src=value.signed_url;recover.hidden=true;renew.hidden=true;openButton.hidden=true;done.disabled=true;cancel.disabled=false;announce('Loading the secure desktop. Keep this page open; the signed-in session has separate opening and mission deadlines.');clearTimeout(frameTimer);frameTimer=setTimeout(()=>{if(done.disabled){announce('The viewer did not confirm a page load. Check or resume this same handoff; do not open the link again.');recover.hidden=false;}},15000);clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{clearFrame();renew.hidden=false;announce('This desktop connection expired. Select Renew to request an owner-approved connection if the same mission is still eligible.');},Math.max(0,viewerDeadline-Date.now()));}
viewer.addEventListener('load',()=>{clearTimeout(frameTimer);if(!terminal&&viewer.src!=='about:blank'){done.disabled=false;announce('The viewer page loaded; this does not confirm that the remote desktop is interactive. Confirm it responds before selecting Done.');}});
viewer.addEventListener('error',()=>{if(!terminal)showRecovery(reasonText.desktop_unavailable,false);});
async function finish(action){if(terminal||!handoffId)return;terminal=true;clearTimeout(countdownTimer);done.disabled=true;cancel.disabled=true;recover.hidden=true;renew.hidden=true;openButton.hidden=true;reconcileButton.hidden=true;clearFrame();announce(action==='complete'?'Saving and releasing control…':'Canceling and releasing control…');try{const result=await post(action,{handoff_id:handoffId});const confirmed=action==='complete'?result.status==='saved'&&result.human_input_revoked===true&&result.checkpoint_saved===true&&result.mission_released===true:result.status==='expired'&&result.human_input_revoked===true&&result.mission_released===true;if(!confirmed)throw new Error('retryable');clearSelection();announce(action==='complete'?'Signed-in browser saved. Control released.':'Handoff canceled. Control released.');}catch{announce('Release could not be confirmed. This action will not be repeated. Select Check status to reconcile the same handoff.');recover.hidden=false;}}
done.addEventListener('click',()=>finish('complete'));cancel.addEventListener('click',()=>finish('expire'));
async function openPrepared(){openButton.disabled=true;try{openView(await post('open',{handoff_id:handoffId}));}catch(error){announce(reasonText[error?.message]||'This prepared handoff could not be opened. Check status before continuing.');recover.hidden=false;}finally{openButton.disabled=false;}}
openButton.addEventListener('click',openPrepared);
async function reconcileSaved(){reconcileButton.disabled=true;try{const result=await post('reconcile',{handoff_id:handoffId});if(result.status!=='saved'||result.human_input_revoked!==true||result.checkpoint_saved!==true||result.mission_released!==true)throw new Error('retryable');terminal=true;clearTimeout(countdownTimer);clearSelection();reconcileButton.hidden=true;announce('Signed-in browser saved. Control released.');}catch(error){announce(withReference('The saved handoff is confirmed, but release is not yet confirmed. Select Check status before taking another action.',error));recover.hidden=false;}finally{reconcileButton.disabled=false;}}
reconcileButton.addEventListener('click',reconcileSaved);
bootstrapButton.addEventListener('click',async()=>{bootstrapButton.disabled=true;try{await startTicket();}catch(error){if(['opening_expired','mission_expired','mission_revoked','recovery_state_missing'].includes(error?.message)){pendingToken='';bootstrapButton.hidden=true;showRecovery(withReference(reasonText[error.message],error),true);}else{announce(withReference(error?.message==='cookie_unavailable'?'Secure browser setup is unavailable because this browser is not accepting the required cookie. No desktop was opened.':'Secure browser setup could not be reached. Check your connection, then select Check secure browser setup again.',error));bootstrapButton.hidden=false;}}finally{bootstrapButton.disabled=false;}});
recover.addEventListener('click',async()=>{recover.disabled=true;try{if(terminal){const value=await post('status',{handoff_id:handoffId});if(value.cleanup_required===true){reconcileButton.hidden=false;announce('The saved handoff is confirmed. Select Confirm saved handoff release to finish releasing control.');}else if(value.status==='saved'||value.status==='expired'){clearTimeout(countdownTimer);clearSelection();announce(value.status==='saved'?'Signed-in browser saved and control released.':'Handoff canceled and control released.');}else announce(reasonText[value.reason]||'Release is still being reconciled. Do not repeat Done; ask your agent to check the same handoff.');return;}const check=await post('status',{handoff_id:handoffId});setTarget(check.target_label);if(check.cleanup_required===true){reconcileButton.hidden=false;announce('The saved handoff is confirmed. Select Confirm saved handoff release to finish releasing control.');return;}if(check.status==='saved'||check.status==='expired'){terminal=true;clearTimeout(countdownTimer);clearSelection();announce(check.status==='saved'?'Signed-in browser saved and control released.':'Handoff canceled and control released.');return;}if(check.status==='ready_for_open'){openButton.hidden=false;announce('This handoff is prepared. Select Open prepared desktop to start the one allowed exchange.');return;}if(check.renewal_allowed===true){renew.hidden=false;announce('The previous viewing grant expired. Select Renew secure viewing to request another connection for this same mission.');return;}const value=await post('recover',{handoff_id:handoffId});openView(value);}catch(error){if(['retryable','operation_pending','desktop_unavailable'].includes(error?.message)){recover.hidden=false;announce(withReference(reasonText[error?.message]||'The handoff could not be reached. Check your connection, then select Check or resume again before the mission deadline.',error));}else showRecovery(withReference(reasonText[error?.message]||'This handoff is expired or unavailable. Ask your agent for a new secure link.',error),true);}finally{recover.disabled=false;}});
renew.addEventListener('click',async()=>{renew.disabled=true;try{openView(await post('renew',{handoff_id:handoffId}));}catch(error){announce(reasonText[error?.message]||'Renewal could not be confirmed. Check status before trying again.');recover.hidden=false;}finally{renew.disabled=false;}});
(async()=>{const fragment=new URLSearchParams(window.location.hash.slice(1)), token=fragment.get('token');let id=new URLSearchParams(window.location.search).get('handoff')||storage.get();
  if(token){if(!/^[A-Za-z0-9_-]{43}$/.test(token)){route(window.location.pathname);showRecovery('This secure link is invalid. Ask your agent for a new one.',true);return;}try{id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).slice(0,16).map(value=>value.toString(16).padStart(2,'0')).join('');}catch{route(window.location.pathname);showRecovery('Secure recovery is unavailable in this browser. Ask your agent for a fresh secure link.',true);return;}handoffId=id;pendingToken=token;storage.set(id);query(id);
    try{await startTicket();}
    catch(error){if(['opening_expired','mission_expired','mission_revoked','recovery_state_missing'].includes(error?.message)){pendingToken='';bootstrapButton.hidden=true;showRecovery(withReference(reasonText[error.message],error),true);}else if(!prepared&&!exchangeAttempted){bootstrapButton.hidden=false;announce(withReference(error?.message==='cookie_unavailable'?'Secure browser setup is unavailable because this browser is not accepting the required cookie. No desktop was opened.':'Secure browser setup could not be reached. Select Check secure browser setup to retry.',error));}else if(error?.message==='retryable'||error?.message==='operation_pending'||error?.message==='desktop_unavailable'){showRecovery(withReference('Opening could not be confirmed. Your secure link was not replayed. Select Check or resume to continue the same handoff.',error),false);recover.hidden=false;}else showRecovery(withReference(reasonText[error?.message]||'This handoff is expired or unavailable. Ask your agent for a new secure link.',error),true);}
    return;
  }
  route(window.location.pathname+(SELECTOR.test(id)?'?handoff='+encodeURIComponent(id):''));
  if(!SELECTOR.test(id)){showRecovery('No active desktop handoff was found. Ask your agent for a new secure link.',true);return;}handoffId=id;storage.set(id);
  try{const value=await post('status',{handoff_id:id});if(!Number.isSafeInteger(value.opening_expires_at)||!Number.isSafeInteger(value.mission_expires_at)||value.mission_expires_at<value.opening_expires_at)throw new Error('terminal');setTarget(value.target_label);openingDeadline=value.opening_expires_at;missionDeadline=value.mission_expires_at;showDeadlines();if(value.cleanup_required===true){reconcileButton.hidden=false;announce('The saved handoff is confirmed. Select Confirm saved handoff release to finish releasing control.');return;}if(value.status==='saved'){terminal=true;clearTimeout(countdownTimer);clearSelection();announce('The signed-in browser was saved and control was released.');return;}if(value.status==='expired'){showRecovery('This handoff has ended. Ask your agent for a new secure link.',true);return;}if(value.status==='ready_for_open'){openButton.hidden=false;announce('This handoff is prepared. Select Open prepared desktop to start the one allowed exchange.');return;}recover.hidden=false;if(value.renewal_allowed===true){renew.hidden=false;announce('The previous viewing grant expired. Select Renew secure viewing to request another connection for this same mission.');}else announce(value.reason?reasonText[value.reason]:value.status==='pending'?'A prior handoff action is still being reconciled. Check status again shortly; do not open another desktop.':'The same handoff is available. Select Check or resume to reconnect the existing desktop.');}
  catch(error){if(['retryable','operation_pending','desktop_unavailable'].includes(error?.message)){recover.hidden=false;announce(withReference(reasonText[error?.message]||'The secure desktop could not be reached. Check your connection and select Check or resume.',error));}else showRecovery(withReference(reasonText[error?.message]||'This handoff is expired or unavailable. Ask your agent for a new secure link.',error),true);}
})();
})();</script></body></html>`;
}
