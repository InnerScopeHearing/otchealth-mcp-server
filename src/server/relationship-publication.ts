import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {AuthContext} from '../auth/bearer.js';
import {loadEnv} from '../config/env.js';
import {relationshipHistoricalAuthority as h,type RelationshipHistoricalReadDeps} from './relationship-historical-read.js';
import {resolveRelationshipPublicationAdmission} from './graph-catalog-controller.js';
import {createRelationshipPublicationStore} from './relationship-publication-store.js';

type Json=Record<string,any>;
type Stored={found:boolean;body?:Buffer;versionId?:string};
type Store={get:(id:string,s:AbortSignal)=>Promise<Stored>;putCreateOnly:(r:{runId:string;body:Buffer},s:AbortSignal)=>Promise<Stored>;list:(r:{after?:string;limit:number;signal:AbortSignal})=>Promise<{records:Array<{runId:string;body:Buffer;versionId?:string}>;next?:string}>};
export interface RelationshipPublicationDeps extends Omit<RelationshipHistoricalReadDeps,'policyJson'>{
 policyJson:()=>string;
 storeFor:(cohortId:string,producerId:string)=>Store;
 resolveAdmission:(input:{cohortId:string;run:Json;ctx:AuthContext;signal:AbortSignal})=>Promise<{admission:Json;proposal:Json}>;
}
const SHA=/^[a-f0-9]{64}$/,RUN=/^run_[a-f0-9]{64}$/,LABEL=/^[a-z0-9][a-z0-9_.:-]{0,95}$/,PRODUCER=/^[a-z][a-z0-9-]{0,63}$/;
const equal=(a:any,b:any)=>h.canonical(a)===h.canonical(b);
function fail(status=403):never{throw Object.assign(Error('relationship_publication_denied'),{status});}
function parse(text:string,now:number):Json|null{
 try{
  if(Buffer.byteLength(text)>65536)return null;const p=JSON.parse(text);
  if(!h.exact(p,['schema','policy_version','expires_at','bindings'])||p.schema!=='relationship-publication-policy-v1'||!LABEL.test(p.policy_version)||!h.utc(p.expires_at)||Date.parse(p.expires_at)<=now+1000||!Array.isArray(p.bindings)||!p.bindings.length||p.bindings.length>32)return null;
  const seen=new Set();for(const b of p.bindings){
   if(!h.exact(b,['authenticated_caller','caller_hash','producer_id','cohort_id','purpose','run_version','encryption','source_policy'])||b.authenticated_caller!=='cfo'||!SHA.test(b.caller_hash)||!PRODUCER.test(b.producer_id)||!LABEL.test(b.cohort_id)||!h.path(b.cohort_id)||!LABEL.test(b.purpose)||!LABEL.test(b.run_version))return null;
   const e=b.encryption;if(!(e?.algorithm==='AES256'&&h.exact(e,['algorithm'])||e?.algorithm==='aws:kms'&&h.exact(e,['algorithm','kms_key_id'])&&typeof e.kms_key_id==='string'&&e.kms_key_id.length>0&&e.kms_key_id.length<=1024&&!/[\r\n]/.test(e.kms_key_id)))return null;
   const s=b.source_policy;if(!h.validSourcePolicy(s))return null;
   const key=b.caller_hash+'/'+b.cohort_id+'/'+b.producer_id;if(seen.has(key))return null;seen.add(key);
  }return p;
 }catch{return null;}
}
function binding(policy:Json,c:Json,g:Json,now:number){
 if(!h.exact(g,['schema','cohort_id','producer_id','caller_hash','run','admission','proposal','artifact_ref','approved_artifacts','issued_under_policy_version'])||g.schema!=='relationship-publication-grant-v1'||g.cohort_id!==c.cohort_id||g.producer_id!==c.producer_id||g.caller_hash!==c.caller_hash||g.run?.purpose!==c.purpose||g.run?.run_version!==c.run_version||!h.artifactRef(g.artifact_ref)||!LABEL.test(g.issued_under_policy_version))fail();
 const b={authenticated_caller:'cfo',caller_hash:c.caller_hash,producer_id:c.producer_id,run:g.run,encryption:c.encryption,cohort_id:c.cohort_id,admission:g.admission,proposal:g.proposal,approved_artifacts:g.approved_artifacts,source_policy:c.source_policy};
 if(!h.parse(h.canonical({schema:'relationship-history-policy-v1',policy_version:policy.policy_version,expires_at:policy.expires_at,bindings:[b]}),now))fail();return b;
}
function stored(r:Stored):Json{
 if(!r.found||!r.body||!r.versionId||!h.version(r.versionId)||r.body.length>128*1024||!Buffer.from(r.body.toString('utf8')).equals(r.body))fail(503);
 try{return JSON.parse(r.body!.toString('utf8'));}catch{fail(503);}
}
/** Derive artifact access from the current CFO session and immutable, server-issued catalog records. */
export async function resolveRelationshipArtifactAutomaticBinding(input:{run_id:string;producer_id:string;ctx:AuthContext;signal:AbortSignal},injected?:{policyJson?:()=>string;now?:()=>number;resolveCatalogCohortBinding?:(ctx:AuthContext,runId:string,signal:AbortSignal)=>Promise<any>;resolveRelationshipPublicationAdmission?:(input:{cohortId:string;run:{run_id:string};ctx:AuthContext;signal:AbortSignal})=>Promise<{admission:Json;proposal:Json}>}){
 const now=injected?.now??Date.now,policy=parse((injected?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_PUBLICATION_POLICY_JSON))(),now());
 if(!policy||input.ctx.caller_agent!=='cfo'||!input.ctx.connector_surface||!SHA.test(input.ctx.caller_hash)||!RUN.test(input.run_id)||!PRODUCER.test(input.producer_id))return null;
 const catalog=await import('./graph-catalog-controller.js'),current=await (injected?.resolveCatalogCohortBinding??catalog.resolveCatalogCohortBinding)(input.ctx,input.run_id,input.signal);
 if(!current)return null;
 const c=policy.bindings.find((row:Json)=>row.cohort_id===current.cohort_id&&row.caller_hash===input.ctx.caller_hash&&row.producer_id===input.producer_id&&row.purpose===current.binding.run.purpose&&row.run_version===current.binding.run.run_version);
 if(!c||!equal(c.source_policy,current.source_policy))return null;
 const pins=await (injected?.resolveRelationshipPublicationAdmission??catalog.resolveRelationshipPublicationAdmission)({cohortId:c.cohort_id,run:{run_id:input.run_id},ctx:input.ctx,signal:input.signal});
 return {binding:{authenticated_caller:'cfo' as const,caller_hash:input.ctx.caller_hash,producer_id:c.producer_id,run:current.binding.run,encryption:c.encryption},cohort_id:c.cohort_id,policy_version:policy.policy_version,expires_at:policy.expires_at,admission:pins.admission,proposal:pins.proposal,source_policy:c.source_policy};
}
async function bounded<T>(f:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)fail(503);return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(Object.assign(Error('publication_cancelled'),{status:503}));};signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{if(signal.aborted)fail(503);return f();}).then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});if(signal.aborted)abort();});
}
async function inspect(d:RelationshipPublicationDeps,policy:Json,c:Json,g:Json,ctx:AuthContext,signal:AbortSignal,wanted?:string){
 const b=binding(policy,c,g,d.now()),[a,p]=await Promise.all([h.pinned(d,b.admission,signal),h.pinned(d,b.proposal,signal)]);if(!h.admissionChain(a,p,b))fail();
 const ref=g.artifact_ref,r=await d.readVersion({key:h.artifactKey(b.run.run_id,c.producer_id,ref.payload_sha256),versionId:ref.version_id,signal,maxBytes:16*1024*1024+1024}),history=h.parseArtifact(r,b,ref.payload_sha256,ref.version_id);
 if(history.payload.schema!=='resolution-history-v1'||Buffer.byteLength(h.canonical(history.payload))!==ref.size_bytes)fail();
 const approved=[ref,...history.payload.sources].map((x:Json)=>({digest:x.payload_sha256,version_id:x.version_id}));
 if(!equal(g.approved_artifacts,approved))fail();const sources:Json[]=[],responses=new Map<string,typeof r>();if(!wanted||wanted===ref.payload_sha256+'/'+ref.version_id)responses.set(ref.payload_sha256+'/'+ref.version_id,r);
 for(const x of history.payload.sources){const response=await d.readVersion({key:h.artifactKey(b.run.run_id,c.producer_id,x.payload_sha256),versionId:x.version_id,signal,maxBytes:16*1024*1024+1024}),s=h.parseArtifact(response,b,x.payload_sha256,x.version_id);if(s.payload.schema!=='resolution-source-input-v1'||Buffer.byteLength(h.canonical(s.payload))!==x.size_bytes||!h.sourceBound(s,b,p))fail();sources.push(s);if(wanted===x.payload_sha256+'/'+x.version_id)responses.set(x.payload_sha256+'/'+x.version_id,response);}
 await h.current(d,b,sources,ctx,signal);const current=await h.current(d,b,sources,ctx,signal);return{current,responses,refresh:()=>h.current(d,b,sources,ctx,signal)};
}
export function registerRelationshipPublicationRoutes(app:FastifyInstance,injected?:Partial<RelationshipPublicationDeps>){
 const base=h.deps(injected),d:RelationshipPublicationDeps={...base,policyJson:injected?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_PUBLICATION_POLICY_JSON),storeFor:injected?.storeFor??((cohort,producer)=>createRelationshipPublicationStore({cohort,producer})),resolveAdmission:injected?.resolveAdmission??(r=>resolveRelationshipPublicationAdmission({...r,run:{run_id:r.run.run_id}}))};
 const budgets=new WeakMap<AbortSignal,{bytes:number;reads:number}>(),rawRead=d.readVersion;d.readVersion=async r=>{const budget=budgets.get(r.signal)??{bytes:0,reads:0};budgets.set(r.signal,budget);if(r.signal.aborted||++budget.reads>256||budget.bytes>=64*1024*1024)fail(503);const result=await rawRead({...r,maxBytes:Math.min(r.maxBytes,64*1024*1024-budget.bytes)});budget.bytes+=result.body.length;if(budget.bytes>64*1024*1024||r.signal.aborted)fail(503);return result;};
 const prefix='/relationship-publications/v1/:cohortId/:producerId';
 const route=(method:'GET'|'POST',url:string,operation:(r:FastifyRequest,p:FastifyReply,c:Json,policy:Json,ctx:AuthContext,s:AbortSignal,recheck:()=>Promise<void>)=>Promise<any>)=>app.route({method,url,bodyLimit:16384,handler:async(req,reply)=>{
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),45000),abort=()=>ctl.abort(),close=()=>{if(!reply.raw.writableFinished)ctl.abort();};req.raw.on('aborted',abort);reply.raw.on('close',close);
  try{
   const params=req.params as Json;if(!LABEL.test(params.cohortId)||!h.path(params.cohortId)||!PRODUCER.test(params.producerId))fail(400);
   const ctx=await bounded(()=>d.authenticate(req,reply),ctl.signal);if(!ctx||ctx.caller_agent!=='cfo'||!ctx.connector_surface||!SHA.test(ctx.caller_hash))fail();
   const policy=parse(d.policyJson(),d.now());if(!policy)fail(404);const c=policy.bindings.find((x:Json)=>x.cohort_id===params.cohortId&&x.producer_id===params.producerId&&x.caller_hash===ctx.caller_hash);if(!c)fail();
   const recheck=async()=>{const auth=await d.authenticate(req,reply);if(!auth||auth.caller_agent!=='cfo'||!auth.connector_surface||auth.caller_hash!==ctx.caller_hash||!equal(parse(d.policyJson(),d.now()),policy)||ctl.signal.aborted)fail();};
   return await bounded(()=>operation(req,reply,c,policy,ctx,ctl.signal,recheck),ctl.signal);
  }catch(e){if(!reply.sent)return reply.code((e as any).status??((e as Error).message==='source_denied'?403:503)).send();}finally{clearTimeout(timer);ctl.abort();req.raw.off('aborted',abort);reply.raw.off('close',close);}
 }});
 route('POST',prefix,async(req,reply,c,policy,ctx,signal,recheck)=>{
  if(new URL(req.url,'http://local').search)fail(400);const input=req.body as Json;if(!h.exact(input,['run','artifact_ref'])||!h.validRun(input.run)||!h.artifactRef(input.artifact_ref)||input.run.purpose!==c.purpose||input.run.run_version!==c.run_version)fail(400);
  const store=d.storeFor(c.cohort_id,c.producer_id),existing=await store.get(input.run.run_id,signal);let grant:Json;
  if(existing.found){grant=stored(existing);if(!equal(grant.run,input.run)||!equal(grant.artifact_ref,input.artifact_ref))fail(409);}
  else{
   const pins=await d.resolveAdmission({cohortId:c.cohort_id,run:input.run,ctx,signal}),ref=input.artifact_ref;
   grant={schema:'relationship-publication-grant-v1',cohort_id:c.cohort_id,producer_id:c.producer_id,caller_hash:ctx.caller_hash,run:input.run,...pins,artifact_ref:ref,approved_artifacts:[{digest:ref.payload_sha256,version_id:ref.version_id}],issued_under_policy_version:policy.policy_version};
   const b=binding(policy,c,grant,d.now()),r=await d.readVersion({key:h.artifactKey(input.run.run_id,c.producer_id,ref.payload_sha256),versionId:ref.version_id,signal,maxBytes:16*1024*1024+1024}),history=h.parseArtifact(r,b,ref.payload_sha256,ref.version_id);if(history.payload.schema!=='resolution-history-v1')fail();grant.approved_artifacts.push(...history.payload.sources.map((x:Json)=>({digest:x.payload_sha256,version_id:x.version_id})));
  }
  if(!(await inspect(d,policy,c,grant,ctx,signal)).current)fail();await recheck();
  const saved=stored(await store.putCreateOnly({runId:input.run.run_id,body:Buffer.from(h.canonical(grant))},signal));if(!equal(saved,grant))fail(409);await recheck();if(!(await inspect(d,policy,c,grant,ctx,signal)).current)fail();await recheck();
  return reply.code(200).send({schema:'relationship-publication-receipt-v1',item:{run:grant.run,producer_id:c.producer_id,artifact_ref:grant.artifact_ref}});
 });
 route('GET',prefix,async(req,reply,c,policy,ctx,signal,recheck)=>{
  const q=new URL(req.url,'http://local').searchParams,after=q.get('after')??undefined,limit=q.has('limit')?Number(q.get('limit')):64;if([...q.keys()].some(k=>!['after','limit'].includes(k))||new Set(q.keys()).size!==q.size||after!==undefined&&!RUN.test(after)||!Number.isInteger(limit)||limit<1||limit>64)fail(400);
  const page=await d.storeFor(c.cohort_id,c.producer_id).list({after,limit,signal});if(page.records.length>limit)fail(503);let last=after??'';
  const items=[],refreshes:Array<()=>Promise<boolean>>=[];for(const r of page.records){const g=stored({found:true,...r});binding(policy,c,g,d.now());if(g.run.run_id!==r.runId||r.runId<=last)fail(503);last=r.runId;refreshes.push((await inspect(d,policy,c,g,ctx,signal)).refresh);items.push({run:g.run,producer_id:c.producer_id,artifact_ref:g.artifact_ref});}if(page.next!==undefined&&(page.next!==last||!items.length))fail(503);await recheck();for(const refresh of refreshes)await refresh();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();return reply.send({schema:'relationship-publication-page-v1',items,next_after:page.next??null});
 });
 route('GET',prefix+'/artifacts/:runId/sha256/:shard/:digest.json',async(req,reply,c,policy,ctx,signal,recheck)=>{
  const p=req.params as Json,q=new URL(req.url,'http://local').searchParams,v=q.get('versionId');if(!RUN.test(p.runId)||!SHA.test(p.digest)||p.shard!==p.digest.slice(0,2)||q.size!==1||!h.version(v))fail(400);
  const g=stored(await d.storeFor(c.cohort_id,c.producer_id).get(p.runId,signal));binding(policy,c,g,d.now());if(g.run.run_id!==p.runId||!g.approved_artifacts.some((x:Json)=>x.digest===p.digest&&x.version_id===v))fail();const checked=await inspect(d,policy,c,g,ctx,signal,p.digest+'/'+v),response=checked.responses.get(p.digest+'/'+v);if(!response)fail();await recheck();const sourceCurrent=await checked.refresh();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();
  reply.header('x-relationship-source-current',String(sourceCurrent)).header('x-relationship-policy-version',policy.policy_version).header('x-relationship-policy-expires-at',new Date(Math.min(Date.parse(policy.expires_at),d.now()+120000)).toISOString()).header('x-relationship-producer',c.producer_id).header('x-amz-version-id',v).header('x-amz-server-side-encryption',c.encryption.algorithm);if(c.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',c.encryption.kms_key_id);return reply.type('application/json').send(response!.body);
 });
}
export const relationshipPublicationTest={parse,binding};
