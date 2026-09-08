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

type RunRef = { ref_version:string; run_id:string; purpose:string; scope:string; run_version:string; manifest_sha256:string };
type Encryption = { algorithm:'AES256'|'aws:kms'; kms_key_id?:string };
type Binding = { authenticated_caller:'cfo'; caller_hash:string; producer_id:string; run:RunRef; encryption:Encryption };
type Policy = { schema:'relationship-artifact-policy-v1'; policy_version:string; expires_at:string; bindings:Binding[] };
type S3Response = { status:number; headers:Headers|Record<string, string|undefined>; body:Buffer };
export type RelationshipArtifactS3 = (input:{method:'GET'|'PUT';key:string;versionId?:string;headers?:Record<string,string>;body?:Buffer;signal:AbortSignal;maxBytes:number})=>Promise<S3Response>;
export interface RelationshipArtifactGatewayDeps {
  authenticate:(request:FastifyRequest, reply:FastifyReply)=>Promise<AuthContext|undefined>;
  policyJson:()=>string;
  now:()=>number;
  s3:RelationshipArtifactS3;
  resolveCohortBinding:(ctx:AuthContext, runId:string, signal:AbortSignal)=>Promise<{policy:unknown;binding:unknown}|null>;
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
function parseBody(body:unknown):unknown|null {
  if(Buffer.isBuffer(body)){if(body.length>MAX_ENVELOPE||!Buffer.from(body.toString('utf8'),'utf8').equals(body))return null;try{return JSON.parse(body.toString('utf8'));}catch{return null;}}
  if(typeof body==='string'){const raw=Buffer.from(body,'utf8');if(raw.length>MAX_ENVELOPE)return null;try{return JSON.parse(body);}catch{return null;}}
  if(body&&typeof body==='object'){if(!validJson(body,-1))return null;const raw=Buffer.from(canonical(body));return raw.length<=MAX_ENVELOPE?body:null;}
  return null;
}
function defaultDeps(injected?:Partial<RelationshipArtifactGatewayDeps>):RelationshipArtifactGatewayDeps {
  const s3=injected?.s3??createRelationshipArtifactS3();
  return {authenticate:injected?.authenticate??requireConnectorAuth,policyJson:injected?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_ARTIFACT_POLICY_JSON),now:injected?.now??Date.now,s3,resolveCohortBinding:injected?.resolveCohortBinding??(async(ctx,run,signal)=>{const catalog=await import('./graph-catalog-controller.js');return catalog.resolveCatalogCohortBinding(ctx,run,signal,{now:injected?.now??Date.now,configs:()=>loadEnv().GRAPH_CATALOG_COHORTS_JSON});})};
}
async function context(request:FastifyRequest,reply:FastifyReply,d:RelationshipArtifactGatewayDeps):Promise<AuthContext|null>{
  if(request.url.includes('?')&&request.method==='PUT'||typeof request.headers.authorization!=='string'){status(reply,401);return null;}
  const ctx=await d.authenticate(request,reply);if(!ctx||ctx.caller_agent!=='cfo'||!ctx.connector_surface||!SHA.test(ctx.caller_hash)){if(!reply.sent)status(reply,403);return null;}return ctx;
}
function params(request:FastifyRequest){const p=request.params as Record<string,string>;return p;}
function select(policy:Policy,ctx:AuthContext,p:Record<string,string>):Binding|null{return policy.bindings.find(b=>b.caller_hash===ctx.caller_hash&&b.producer_id===p.producerId&&b.run.run_id===p.runId)??null;}
async function finalAuth(request:FastifyRequest,reply:FastifyReply,d:RelationshipArtifactGatewayDeps,original:AuthContext):Promise<boolean>{const now=await d.authenticate(request,reply);return !!now&&now.caller_agent===original.caller_agent&&now.connector_surface===original.connector_surface&&now.caller_hash===original.caller_hash;}

export function registerRelationshipArtifactGatewayRoutes(app:FastifyInstance,injected?:Partial<RelationshipArtifactGatewayDeps>):void {
 const d=defaultDeps(injected),url='/relationship-artifacts/v1/:runId/:producerId/sha256/:shard/:digest.json';
 app.route({method:['GET','PUT'],url,bodyLimit:MAX_ENVELOPE,handler:async(request,reply)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000),disconnect=()=>controller.abort();request.raw.on('aborted',disconnect);
  try{
   const p=params(request);if(!/^run_[a-f0-9]{64}$/.test(p.runId)||!PRODUCER.test(p.producerId)||!/^[a-f0-9]{2}$/.test(p.shard)||!SHA.test(p.digest)||p.shard!==p.digest.slice(0,2))return status(reply,400);
   const ctx=await context(request,reply,d);if(!ctx||reply.sent)return;
   const policyText=d.policyJson(),policy=parsePolicy(policyText,d.now());if(!policy)return status(reply,404);
   const binding=select(policy,ctx,p);if(!binding)return status(reply,403);
   if(!await guard(d,ctx,binding,policyText,policy,controller.signal))return status(reply,403);
   const key=artifactKey(p.runId,p.producerId,p.shard,p.digest);
   if(request.method==='PUT'){
    if(!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type']??''))||request.headers['if-none-match']!=='*'||request.headers['if-match']!==undefined)return status(reply,400);
    const body=parseBody(request.body);if(!body||!envelope(body,binding.run,p.digest))return status(reply,400);
    const raw=Buffer.from(canonical(body));if(raw.length>MAX_ENVELOPE)return status(reply,413);
    const headers:Record<string,string>={'content-type':'application/json','if-none-match':'*','x-amz-server-side-encryption':binding.encryption.algorithm,'x-amz-meta-resolution-producer':p.producerId,'x-amz-meta-resolution-run':p.runId};if(binding.encryption.algorithm==='aws:kms')headers['x-amz-server-side-encryption-aws-kms-key-id']=binding.encryption.kms_key_id!;
    const saved=await d.s3({method:'PUT',key,headers,body:raw,signal:controller.signal,maxBytes:64*1024});if(saved.status<200||saved.status>=300)return status(reply,s3Status(saved.status));
    const putVersion=header(saved.headers,'x-amz-version-id');if(!putVersion||putVersion==='null'||!VERSION.test(putVersion)||header(saved.headers,'x-amz-server-side-encryption')!==binding.encryption.algorithm||(binding.encryption.algorithm==='aws:kms'&&header(saved.headers,'x-amz-server-side-encryption-aws-kms-key-id')!==binding.encryption.kms_key_id))return status(reply,503);
    if(!await guard(d,ctx,binding,policyText,policy,controller.signal)||!await finalAuth(request,reply,d,ctx))return status(reply,403);
    reply.header('x-amz-version-id',putVersion).header('x-amz-server-side-encryption',binding.encryption.algorithm);
    if(binding.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',binding.encryption.kms_key_id!);
    return reply.code(saved.status).send();
   }
   const parsed=new URL(request.url,'http://local');const entries=[...parsed.searchParams.entries()];if(entries.some(([k])=>k!=='versionId')||entries.length>1||(entries.length===1&&(entries[0][1]==='null'||!VERSION.test(entries[0][1]))))return status(reply,400);
   const versionId=entries[0]?.[1],saved=await d.s3({method:'GET',key,versionId,signal:controller.signal,maxBytes:MAX_ENVELOPE});if(saved.status!==200)return status(reply,s3Status(saved.status));
   if(saved.body.length>MAX_ENVELOPE||!Buffer.from(saved.body.toString('utf8'),'utf8').equals(saved.body))return status(reply,503);let value:unknown;try{value=JSON.parse(saved.body.toString('utf8'));}catch{return status(reply,503);}
   const gotVersion=header(saved.headers,'x-amz-version-id');if((versionId&&gotVersion!==versionId)||!gotVersion||gotVersion==='null'||!VERSION.test(gotVersion)||!envelope(value,binding.run,p.digest)||header(saved.headers,'x-amz-meta-resolution-producer')!==p.producerId||header(saved.headers,'x-amz-meta-resolution-run')!==p.runId||header(saved.headers,'x-amz-server-side-encryption')!==binding.encryption.algorithm)return status(reply,503);
   if(binding.encryption.algorithm==='aws:kms'&&header(saved.headers,'x-amz-server-side-encryption-aws-kms-key-id')!==binding.encryption.kms_key_id)return status(reply,503);
   if(!await guard(d,ctx,binding,policyText,policy,controller.signal)||!await finalAuth(request,reply,d,ctx))return status(reply,403);
   reply.header('x-amz-version-id',gotVersion).header('x-amz-server-side-encryption',binding.encryption.algorithm);
   if(binding.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',binding.encryption.kms_key_id!);
   return reply.code(200).type('application/json').send(saved.body);
  }catch{return !reply.sent?status(reply,503):undefined;}finally{clearTimeout(timer);controller.abort();request.raw.off('aborted',disconnect);}
 }});
}
export const relationshipArtifactGatewayTest={canonical,hash,parsePolicy,validRun,envelope,artifactKey};
