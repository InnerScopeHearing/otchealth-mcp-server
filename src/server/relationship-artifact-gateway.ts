import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireConnectorAuth, type AuthContext } from '../auth/bearer.js';
import { loadEnv } from '../config/env.js';
import { createRelationshipArtifactS3 } from './relationship-artifact-s3.js';

const WORKERS = 'graph-trial/20260908/workers/cfo';
const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_ENVELOPE = MAX_PAYLOAD + 1024;
const SHA = /^[a-f0-9]{64}$/;
const LABEL = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const PRODUCER = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^[^\s\p{C}]{1,1024}$/u;
export const RELATIONSHIP_GATEWAY_STORE_ID='relationship-gateway-v1';

type RunRef = { ref_version:string; run_id:string; purpose:string; scope:string; run_version:string; manifest_sha256:string };
type Encryption = { algorithm:'AES256'|'aws:kms'; kms_key_id?:string };
type Binding = { authenticated_caller:'cfo'; caller_hash:string; producer_id:string; run:RunRef; encryption:Encryption };
type Policy = { schema:'relationship-artifact-policy-v1'; policy_version:string; expires_at:string; bindings:Binding[] };
type Pin = { key:string; version_id:string; sha256:string };
type AutomaticBinding = { binding:Binding; cohort_id:string; policy_version:string; expires_at:string; admission:Pin; proposal:Pin; source_policy:unknown };
type S3Response = { status:number; headers:Headers|Record<string, string|undefined>; body:Buffer };
export type RelationshipArtifactS3 = (input:{method:'GET'|'PUT';key:string;versionId?:string;headers?:Record<string,string>;body?:Buffer;signal:AbortSignal;maxBytes:number})=>Promise<S3Response>;
export interface RelationshipArtifactGatewayDeps {
  authenticate:(request:FastifyRequest, reply:FastifyReply)=>Promise<AuthContext|undefined>;
  policyJson:()=>string;
  now:()=>number;
  s3:RelationshipArtifactS3;
  resolveCohortBinding:(ctx:AuthContext, runId:string, signal:AbortSignal)=>Promise<{policy:unknown;binding:unknown}|null>;
  resolveAutomaticBinding:(ctx:AuthContext, runId:string, producerId:string, signal:AbortSignal)=>Promise<AutomaticBinding|null>;
}

function hash(value:string|Buffer){ return createHash('sha256').update(value).digest('hex'); }
function canonical(value:unknown):string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row=value as Record<string,unknown>;
  return '{' + Object.keys(row).sort().map(k=>JSON.stringify(k)+':'+canonical(row[k])).join(',') + '}';
}
function exact(value:unknown, keys:readonly string[]):value is Record<string,unknown> {
  return !!value && Object.getPrototypeOf(value)===Object.prototype && Object.keys(value as object).sort().join('\0')===[...keys].sort().join('\0');
}
function bounded(value:unknown, max=240):value is string { return typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0'); }
function utc(value:unknown):value is string { return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value; }
function runContent(run:RunRef){return {ref_version:run.ref_version,purpose:run.purpose,scope:run.scope,run_version:run.run_version,manifest_sha256:run.manifest_sha256};}
function validRun(value:unknown):value is RunRef {
  if(!exact(value,['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])) return false;
  const run=value as unknown as RunRef;
  return run.ref_version==='neptune-trial-active-run-ref-v1'&&/^run_[a-f0-9]{64}$/.test(run.run_id)&&LABEL.test(run.purpose)&&LABEL.test(run.scope)&&LABEL.test(run.run_version)&&SHA.test(run.manifest_sha256)&&run.run_id==='run_'+hash(canonical(runContent(run)));
}
function same(a:unknown,b:unknown){return canonical(a)===canonical(b);}
function validJson(value:unknown, depth=0):boolean {
  if(depth>128) return false;
  if(value===null||typeof value==='boolean'||typeof value==='number') return value===null||typeof value!=='number'||Number.isFinite(value);
  if(typeof value==='string') return value.length<=MAX_PAYLOAD;
  if(Array.isArray(value)) return value.every(v=>validJson(v,depth+1));
  return !!value&&Object.getPrototypeOf(value)===Object.prototype&&Object.values(value as Record<string,unknown>).every(v=>validJson(v,depth+1));
}
function validEncryption(value:unknown):value is Encryption {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype) return false;
  const row=value as Record<string,unknown>;
  if(row.algorithm==='AES256') return exact(value,['algorithm']);
  return row.algorithm==='aws:kms'&&exact(value,['algorithm','kms_key_id'])&&bounded(row.kms_key_id,1024);
}
function validSourcePolicy(value:unknown):boolean { if(!value||Object.getPrototypeOf(value)!==Object.prototype)return false;const s=value as Record<string,unknown>,all=s.source_scope==='all_cfo_source_documents',keys=all?['catalog_key','catalog_source_sha256','source_prefixes','source_scope']:['catalog_key','catalog_source_sha256','source_prefixes'];if(!exact(s,keys)||typeof s.catalog_key!=='string'||!s.catalog_key.startsWith('graph-trial/')||!s.catalog_key.endsWith('.jsonl')||!SHA.test(String(s.catalog_source_sha256))||!Array.isArray(s.source_prefixes))return false;if(all)return s.source_prefixes.length===0;return s.source_scope===undefined&&s.source_prefixes.length>0&&s.source_prefixes.length<=32&&s.source_prefixes.every(p=>typeof p==='string'&&p.endsWith('/')&&p.length<=1024&&!p.startsWith('/')&&!/[\\%?#:\u0000-\u001f\u007f]/.test(p.slice(0,-1)))&&new Set(s.source_prefixes).size===s.source_prefixes.length; }
function validPin(value:unknown, key:RegExp):value is Pin { return !!value&&exact(value,['key','version_id','sha256'])&&typeof (value as any).key==='string'&&key.test((value as any).key)&&typeof (value as any).version_id==='string'&&(value as any).version_id!=='null'&&VERSION.test((value as any).version_id)&&typeof (value as any).sha256==='string'&&SHA.test((value as any).sha256); }
function validAutomatic(value:unknown, ctx:AuthContext, runId:string, producerId:string, now:number):value is AutomaticBinding {
 if(!value||!exact(value,['binding','cohort_id','policy_version','expires_at','admission','proposal','source_policy']))return false;
 const row=value as Record<string,unknown>,b=row.binding as Binding,cohort=typeof row.cohort_id==='string'?row.cohort_id:'';
 if(!LABEL.test(cohort)||!bounded(row.policy_version)||!utc(row.expires_at)||Date.parse(row.expires_at)<now+1000||!b||b.authenticated_caller!=='cfo'||b.caller_hash!==ctx.caller_hash||b.producer_id!==producerId||!validRun(b.run)||b.run.run_id!==runId||!validEncryption(b.encryption)||!validSourcePolicy(row.source_policy))return false;
 const root=`graph-trial/20260908/catalog-cohorts/${cohort}/server/`;
 return validPin(row.admission,new RegExp('^'+root.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'admissions/'+runId+'\\.json$'))&&validPin(row.proposal,new RegExp('^'+root.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'proposals/[a-f0-9]{64}\\.json$'));
}
function parsePolicy(text:string, now:number):Policy|null {
  let raw:unknown; try{raw=JSON.parse(text);}catch{return null;}
  if(!exact(raw,['schema','policy_version','expires_at','bindings'])) return null;
  const row=raw as Record<string,unknown>;
  if(row.schema!=='relationship-artifact-policy-v1'||!bounded(row.policy_version)||!utc(row.expires_at)||Date.parse(row.expires_at)<now+1000||!Array.isArray(row.bindings)||row.bindings.length<1||row.bindings.length>128)return null;
  const bindings:Binding[]=[];
  for(const value of row.bindings){
    if(!exact(value,['authenticated_caller','caller_hash','producer_id','run','encryption']))return null;
    const b=value as Record<string,unknown>;
    if(b.authenticated_caller!=='cfo'||typeof b.caller_hash!=='string'||!SHA.test(b.caller_hash)||typeof b.producer_id!=='string'||!PRODUCER.test(b.producer_id)||!validRun(b.run)||!validEncryption(b.encryption))return null;
    bindings.push({authenticated_caller:'cfo',caller_hash:b.caller_hash,producer_id:b.producer_id,run:b.run as RunRef,encryption:b.encryption as Encryption});
  }
  const ids=bindings.map(b=>b.caller_hash+'\0'+b.producer_id+'\0'+b.run.run_id);
  if(new Set(ids).size!==ids.length)return null;
  return {schema:'relationship-artifact-policy-v1',policy_version:row.policy_version as string,expires_at:row.expires_at as string,bindings};
}
function artifactKey(run:string, producer:string, shard:string, digest:string){return `${WORKERS}/${run}/relationship-producers/${producer}/resolution-artifacts/sha256/${shard}/${digest}.json`;}
function header(headers:S3Response['headers'], name:string):string|undefined {
  if(headers instanceof Headers)return headers.get(name)??undefined;
  const found=Object.entries(headers).find(([key])=>key.toLowerCase()===name.toLowerCase()); return found?.[1];
}
function status(reply:FastifyReply, code:number){return reply.code(code).send();}
function s3Status(code:number){return code===404||code===409||code===412||(code>=500&&code<=599)?code:503;}
function stateKey(run:RunRef){return `${WORKERS}/${run.run_id}/active-runs/${hash(canonical({purpose:run.purpose,scope:'finance'}))}.json`;}
async function active(d:RelationshipArtifactGatewayDeps,binding:Binding,signal:AbortSignal):Promise<boolean>{
  const saved=await d.s3({method:'GET',key:stateKey(binding.run),signal,maxBytes:64*1024});
  if(saved.status!==200||saved.body.length>64*1024)return false;
  let value:unknown;try{value=JSON.parse(saved.body.toString('utf8'));}catch{return false;}
  if(!exact(value,['schema','state_sha256','state'])||value.schema!=='neptune-trial-active-run-state-v1'||!SHA.test(String(value.state_sha256??''))||hash(canonical(value.state))!==value.state_sha256||!exact(value.state,['status','run','superseded_run','tombstone']))return false;
  return value.state.status==='active'&&value.state.superseded_run===null&&value.state.tombstone===null&&same(value.state.run,binding.run)&&!!header(saved.headers,'etag');
}
function admitted(value:unknown, ctx:AuthContext, binding:Binding, now:number):boolean {
  if(!value||typeof value!=='object')return false;
  const row=value as Record<string,unknown>, policy=row.policy as Record<string,unknown>|undefined, b=row.binding as Record<string,unknown>|undefined;
  return !!policy&&policy.schema==='graph-worker-bindings-v1'&&typeof policy.expires_at==='string'&&Date.parse(policy.expires_at)>now+1000&&!!b&&b.authenticated_caller==='cfo'&&b.room==='finance'&&b.source_index==='finance-cfo-source-docs'&&same(b.run,binding.run)&&ctx.caller_agent==='cfo';
}
async function guard(d:RelationshipArtifactGatewayDeps,ctx:AuthContext,binding:Binding,policyText:string,expected:Policy,signal:AbortSignal):Promise<boolean>{
  const text=d.policyJson(), current=parsePolicy(text,d.now());
  if(text!==policyText||!current||!same(current,expected))return false;
  const cohort=await d.resolveCohortBinding(ctx,binding.run.run_id,signal);
  if(!admitted(cohort,ctx,binding,d.now())||!await active(d,binding,signal)||!admitted(cohort,ctx,binding,d.now()))return false;
  const finalText=d.policyJson(), final=parsePolicy(finalText,d.now());
  return finalText===policyText&&!!final&&same(final,expected);
}
function payloadValid(value:unknown, run:RunRef):boolean {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)return false;
  const row=value as Record<string,unknown>;
  if(row.schema==='resolution-source-input-v1')return exact(value,['schema','run','input'])&&same(row.run,run);
  return row.schema==='resolution-history-v1'&&exact(value,['schema','run','caller_seat','sources','events','queries'])&&same(row.run,run)&&row.caller_seat==='cfo'&&Array.isArray(row.sources)&&Array.isArray(row.events)&&Array.isArray(row.queries);
}
function envelope(value:unknown, run:RunRef, digest:string):value is {schema:'relationship-resolution-artifact-v1';payload_sha256:string;payload:unknown}{
  return exact(value,['schema','payload_sha256','payload'])&&value.schema==='relationship-resolution-artifact-v1'&&value.payload_sha256===digest&&validJson(value.payload)&&payloadValid(value.payload,run)&&Buffer.byteLength(canonical(value.payload),'utf8')<=MAX_PAYLOAD&&hash(canonical(value.payload))===digest;
}
function validArtifactRef(value:unknown){if(!exact(value,['schema','artifact_id','bucket','key','payload_sha256','version_id','size_bytes']))return false;const r=value as Record<string,unknown>,d=r.payload_sha256;return r.schema==='relationship-resolution-artifact-ref-v1'&&typeof d==='string'&&SHA.test(d)&&r.artifact_id==='resart_'+d&&r.bucket==='otchealth-finance-legal-dr-55c84f6b'&&r.key===`resolution-artifacts/sha256/${d.slice(0,2)}/${d}.json`&&typeof r.version_id==='string'&&r.version_id!=='null'&&VERSION.test(r.version_id)&&typeof r.size_bytes==='number'&&Number.isSafeInteger(r.size_bytes)&&r.size_bytes>=0&&r.size_bytes<=MAX_PAYLOAD;}
function authRequest(value:unknown,run:RunRef){return exact(value,['action','artifact_ref','run','caller_seat','store_id'])&&['write','read'].includes(String((value as any).action))&&same((value as any).run,run)&&(value as any).caller_seat==='cfo'&&(value as any).store_id===RELATIONSHIP_GATEWAY_STORE_ID&&(((value as any).action==='write'&&(value as any).artifact_ref===null)||((value as any).action==='read'&&validArtifactRef((value as any).artifact_ref)));}
function storageAuthRequest(value:unknown){if(!value||typeof value!=='object')return false;const v=value as any,base=['action','scope','artifact_id','sha256'];const keys=v.action==='get'?[...base,'version_id']:base;if(!exact(v,keys)||typeof v.action!=='string'||!['get','put'].includes(v.action)||!exact(v.scope,['run','caller_seat','producer_id'])||!validRun(v.scope.run)||v.scope.caller_seat!=='cfo'||typeof v.scope.producer_id!=='string'||!PRODUCER.test(v.scope.producer_id)||typeof v.sha256!=='string'||!SHA.test(v.sha256)||v.artifact_id!=='resart_'+v.sha256)return false;return v.action==='put'||(typeof v.version_id==='string'&&v.version_id!=='null'&&VERSION.test(v.version_id));}
function parseBody(body:unknown):unknown|null {
  if(Buffer.isBuffer(body)){if(body.length>MAX_ENVELOPE||!Buffer.from(body.toString('utf8'),'utf8').equals(body))return null;try{return JSON.parse(body.toString('utf8'));}catch{return null;}}
  if(typeof body==='string'){const raw=Buffer.from(body,'utf8');if(raw.length>MAX_ENVELOPE)return null;try{return JSON.parse(body);}catch{return null;}}
  if(body&&typeof body==='object'){if(!validJson(body,-1))return null;const raw=Buffer.from(canonical(body));return raw.length<=MAX_ENVELOPE?body:null;}
  return null;
}
function defaultDeps(injected?:Partial<RelationshipArtifactGatewayDeps>):RelationshipArtifactGatewayDeps {
  const s3=injected?.s3??createRelationshipArtifactS3();
  return {authenticate:injected?.authenticate??requireConnectorAuth,policyJson:injected?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_ARTIFACT_POLICY_JSON),now:injected?.now??Date.now,s3,resolveCohortBinding:injected?.resolveCohortBinding??(async(ctx,run,signal)=>{const catalog=await import('./graph-catalog-controller.js');return catalog.resolveCatalogCohortBinding(ctx,run,signal,{now:injected?.now??Date.now,configs:()=>loadEnv().GRAPH_CATALOG_COHORTS_JSON});}),resolveAutomaticBinding:injected?.resolveAutomaticBinding??(async(ctx,run,producer,signal)=>{const publication=await import('./relationship-publication.js'),automatic:unknown=await publication.resolveRelationshipArtifactAutomaticBinding({ctx,run_id:run,producer_id:producer,signal},{now:injected?.now??Date.now});return automatic as AutomaticBinding|null;})};
}
async function automaticGuard(d:RelationshipArtifactGatewayDeps,ctx:AuthContext,expected:AutomaticBinding,signal:AbortSignal):Promise<boolean>{
 const current=await d.resolveAutomaticBinding(ctx,expected.binding.run.run_id,expected.binding.producer_id,signal);
 if(!validAutomatic(current,ctx,expected.binding.run.run_id,expected.binding.producer_id,d.now())||!same(current,expected))return false;
 const cohort=await d.resolveCohortBinding(ctx,expected.binding.run.run_id,signal);
 if(!admitted(cohort,ctx,expected.binding,d.now())||!await active(d,expected.binding,signal))return false;
 const final=await d.resolveAutomaticBinding(ctx,expected.binding.run.run_id,expected.binding.producer_id,signal);
 return validAutomatic(final,ctx,expected.binding.run.run_id,expected.binding.producer_id,d.now())&&same(final,expected);
}
type Authority = { mode:'static'; binding:Binding; policy:Policy; policyText:string }|{ mode:'automatic'; binding:Binding; automatic:AutomaticBinding };
async function authority(d:RelationshipArtifactGatewayDeps,ctx:AuthContext,p:Record<string,string>,run:RunRef|null,signal:AbortSignal):Promise<Authority|null>{
 const policyText=d.policyJson(),policy=parsePolicy(policyText,d.now());
 if(policy){const binding=select(policy,ctx,p);return binding&&(!run||same(run,binding.run))?{mode:'static',binding,policy,policyText}:null;}
 if(policyText!=='')return null;
 const automatic=await d.resolveAutomaticBinding(ctx,p.runId,p.producerId,signal);
 return validAutomatic(automatic,ctx,p.runId,p.producerId,d.now())&&(!run||same(run,automatic.binding.run))?{mode:'automatic',binding:automatic.binding,automatic}:null;
}
async function guarded(d:RelationshipArtifactGatewayDeps,ctx:AuthContext,a:Authority,signal:AbortSignal){return a.mode==='static'?guard(d,ctx,a.binding,a.policyText,a.policy,signal):automaticGuard(d,ctx,a.automatic,signal);}
async function context(request:FastifyRequest,reply:FastifyReply,d:RelationshipArtifactGatewayDeps):Promise<AuthContext|null>{
  if(request.url.includes('?')&&request.method==='PUT'||typeof request.headers.authorization!=='string'){status(reply,401);return null;}
  const ctx=await d.authenticate(request,reply);if(!ctx||ctx.caller_agent!=='cfo'||!ctx.connector_surface||!SHA.test(ctx.caller_hash)){if(!reply.sent)status(reply,403);return null;}return ctx;
}
function params(request:FastifyRequest){const p=request.params as Record<string,string>;return p;}
function select(policy:Policy,ctx:AuthContext,p:Record<string,string>):Binding|null{return policy.bindings.find(b=>b.caller_hash===ctx.caller_hash&&b.producer_id===p.producerId&&b.run.run_id===p.runId)??null;}
async function finalAuth(request:FastifyRequest,reply:FastifyReply,d:RelationshipArtifactGatewayDeps,original:AuthContext):Promise<boolean>{const now=await d.authenticate(request,reply);return !!now&&now.caller_agent===original.caller_agent&&now.connector_surface===original.connector_surface&&now.caller_hash===original.caller_hash;}

export function registerRelationshipArtifactGatewayRoutes(app:FastifyInstance,injected?:Partial<RelationshipArtifactGatewayDeps>):void {
 const d=defaultDeps(injected),url='/relationship-artifacts/v1/:runId/:producerId/sha256/:shard/:digest.json';
 app.route({method:'POST',url:'/relationship-artifacts/v1/:runId/:producerId/authorize',bodyLimit:16*1024,handler:async(request,reply)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000),disconnect=()=>controller.abort();request.raw.on('aborted',disconnect);
  try{const p=params(request),raw=request.body as any,durable=authRequest(raw,raw?.run as RunRef),storage=storageAuthRequest(raw),requestRun:any=durable?raw.run:storage?raw.scope.run:null;if(request.url.includes('?')||!/^run_[a-f0-9]{64}$/.test(p.runId)||!PRODUCER.test(p.producerId)||(!durable&&!storage)||!validRun(requestRun)||requestRun?.run_id!==p.runId||(storage&&raw.scope.producer_id!==p.producerId))return status(reply,400);
   const ctx=await context(request,reply,d);if(!ctx||reply.sent)return;const a=await authority(d,ctx,p,requestRun,controller.signal);if(!a)return status(reply,403);const binding=a.binding;
   if(!await guarded(d,ctx,a,controller.signal))return status(reply,403);
   const body=request.body as any;
   if(body.action==='read'||body.action==='get'){const ref=body.action==='read'?body.artifact_ref:{payload_sha256:body.sha256,version_id:body.version_id,size_bytes:null},key=artifactKey(p.runId,p.producerId,ref.payload_sha256.slice(0,2),ref.payload_sha256),saved=await d.s3({method:'GET',key,versionId:ref.version_id,signal:controller.signal,maxBytes:MAX_ENVELOPE});if(saved.status!==200||saved.body.length>MAX_ENVELOPE||!Buffer.from(saved.body.toString('utf8'),'utf8').equals(saved.body))return status(reply,403);let value:unknown;try{value=JSON.parse(saved.body.toString('utf8'));}catch{return status(reply,403);}if(header(saved.headers,'x-amz-version-id')!==ref.version_id||header(saved.headers,'x-amz-meta-resolution-producer')!==p.producerId||header(saved.headers,'x-amz-meta-resolution-run')!==p.runId||header(saved.headers,'x-amz-server-side-encryption')!==binding.encryption.algorithm||(binding.encryption.algorithm==='aws:kms'&&header(saved.headers,'x-amz-server-side-encryption-aws-kms-key-id')!==binding.encryption.kms_key_id)||!envelope(value,binding.run,ref.payload_sha256)||(ref.size_bytes!==null&&Buffer.byteLength(canonical((value as any).payload),'utf8')!==ref.size_bytes))return status(reply,403);}
   if(!await guarded(d,ctx,a,controller.signal)||!await finalAuth(request,reply,d,ctx))return status(reply,403);
   return reply.send({allowed:true,authorization_request_sha256:hash(canonical(body)),provenance:{decision_source:a.mode==='static'?'authenticated_resolution_store':'automatic_catalog_publication_admission',policy_version:a.mode==='static'?a.policy.policy_version:a.automatic.policy_version,authenticated_store_id:RELATIONSHIP_GATEWAY_STORE_ID,authenticated_producer_id:p.producerId,allowed_roles:['cfo'],...(a.mode==='automatic'?{cohort_id:a.automatic.cohort_id,admission_sha256:a.automatic.admission.sha256,proposal_sha256:a.automatic.proposal.sha256}: {})}});
  }catch{return !reply.sent?status(reply,503):undefined;}finally{clearTimeout(timer);controller.abort();request.raw.off('aborted',disconnect);}
 }});
 app.route({method:['GET','PUT'],url,bodyLimit:MAX_ENVELOPE,handler:async(request,reply)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000),disconnect=()=>controller.abort();request.raw.on('aborted',disconnect);
  try{
   const p=params(request);if(!/^run_[a-f0-9]{64}$/.test(p.runId)||!PRODUCER.test(p.producerId)||!/^[a-f0-9]{2}$/.test(p.shard)||!SHA.test(p.digest)||p.shard!==p.digest.slice(0,2))return status(reply,400);
   const ctx=await context(request,reply,d);if(!ctx||reply.sent)return;
   const a=await authority(d,ctx,p,null,controller.signal);if(!a)return status(reply,403);const binding=a.binding;
   if(!await guarded(d,ctx,a,controller.signal))return status(reply,403);
   const key=artifactKey(p.runId,p.producerId,p.shard,p.digest);
   if(request.method==='PUT'){
    if(!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type']??''))||request.headers['if-none-match']!=='*'||request.headers['if-match']!==undefined)return status(reply,400);
    const body=parseBody(request.body);if(!body||!envelope(body,binding.run,p.digest))return status(reply,400);
    const raw=Buffer.from(canonical(body));if(raw.length>MAX_ENVELOPE)return status(reply,413);
    const headers:Record<string,string>={'content-type':'application/json','if-none-match':'*','x-amz-server-side-encryption':binding.encryption.algorithm,'x-amz-meta-resolution-producer':p.producerId,'x-amz-meta-resolution-run':p.runId};if(binding.encryption.algorithm==='aws:kms')headers['x-amz-server-side-encryption-aws-kms-key-id']=binding.encryption.kms_key_id!;
    const saved=await d.s3({method:'PUT',key,headers,body:raw,signal:controller.signal,maxBytes:64*1024});if(saved.status<200||saved.status>=300)return status(reply,s3Status(saved.status));
    const putVersion=header(saved.headers,'x-amz-version-id');if(!putVersion||putVersion==='null'||!VERSION.test(putVersion)||header(saved.headers,'x-amz-server-side-encryption')!==binding.encryption.algorithm||(binding.encryption.algorithm==='aws:kms'&&header(saved.headers,'x-amz-server-side-encryption-aws-kms-key-id')!==binding.encryption.kms_key_id))return status(reply,503);
    if(!await guarded(d,ctx,a,controller.signal)||!await finalAuth(request,reply,d,ctx))return status(reply,403);
    reply.header('x-amz-version-id',putVersion).header('x-amz-server-side-encryption',binding.encryption.algorithm);
    if(binding.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',binding.encryption.kms_key_id!);
    return reply.code(saved.status).send();
   }
   const parsed=new URL(request.url,'http://local');const entries=[...parsed.searchParams.entries()];if(entries.some(([k])=>k!=='versionId')||entries.length>1||(entries.length===1&&(entries[0][1]==='null'||!VERSION.test(entries[0][1]))))return status(reply,400);
   const versionId=entries[0]?.[1],saved=await d.s3({method:'GET',key,versionId,signal:controller.signal,maxBytes:MAX_ENVELOPE});if(saved.status!==200)return status(reply,s3Status(saved.status));
   if(saved.body.length>MAX_ENVELOPE||!Buffer.from(saved.body.toString('utf8'),'utf8').equals(saved.body))return status(reply,503);let value:unknown;try{value=JSON.parse(saved.body.toString('utf8'));}catch{return status(reply,503);}
   const gotVersion=header(saved.headers,'x-amz-version-id');if((versionId&&gotVersion!==versionId)||!gotVersion||gotVersion==='null'||!VERSION.test(gotVersion)||!envelope(value,binding.run,p.digest)||header(saved.headers,'x-amz-meta-resolution-producer')!==p.producerId||header(saved.headers,'x-amz-meta-resolution-run')!==p.runId||header(saved.headers,'x-amz-server-side-encryption')!==binding.encryption.algorithm)return status(reply,503);
   if(binding.encryption.algorithm==='aws:kms'&&header(saved.headers,'x-amz-server-side-encryption-aws-kms-key-id')!==binding.encryption.kms_key_id)return status(reply,503);
   if(!await guarded(d,ctx,a,controller.signal)||!await finalAuth(request,reply,d,ctx))return status(reply,403);
   reply.header('x-amz-version-id',gotVersion).header('x-amz-server-side-encryption',binding.encryption.algorithm);
   if(binding.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',binding.encryption.kms_key_id!);
   return reply.code(200).type('application/json').send(saved.body);
  }catch{return !reply.sent?status(reply,503):undefined;}finally{clearTimeout(timer);controller.abort();request.raw.off('aborted',disconnect);}
 }});
}
export const relationshipArtifactGatewayTest={canonical,hash,parsePolicy,validRun,envelope,artifactKey};
