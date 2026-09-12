import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {requireConnectorAuth,type AuthContext} from '../auth/bearer.js';
import {loadEnv} from '../config/env.js';
import {createCfoTextSnapshotReader} from '../graph/cfo-text-snapshot.js';
import {createRelationshipHistoryS3} from './relationship-history-s3.js';
import {readPinnedGraphCatalog} from './graph-catalog-reader.js';
import {planGraphCatalogPage} from './graph-catalog-planner.js';
type Json=Record<string,any>;
type Source={catalog_key:string;catalog_source_sha256:string;source_prefixes:string[];source_scope?:'all_cfo_source_documents'};
export type HistoricalReadResult={status:number;headers:Headers|Record<string,string|undefined>;body:Buffer};
export interface RelationshipHistoricalReadDeps{
 authenticate:(r:FastifyRequest,p:FastifyReply)=>Promise<AuthContext|undefined>;policyJson:()=>string;now:()=>number;
 readVersion:(r:{key:string;versionId:string;signal:AbortSignal;maxBytes:number})=>Promise<HistoricalReadResult>;
 readCatalog:(s:Source,signal:AbortSignal)=>Promise<readonly unknown[]>;
 checkSource:(row:Json,binding:Json,ctx:AuthContext,signal:AbortSignal)=>Promise<boolean>;
}
const BUCKET='otchealth-finance-legal-dr-55c84f6b',BASE='graph-trial/20260908/workers/cfo',MAX_PAYLOAD=16*1024*1024,MAX=MAX_PAYLOAD+1024;
const SHA=/^[a-f0-9]{64}$/,LABEL=/^[a-z0-9][a-z0-9_.:-]{0,95}$/,PRODUCER=/^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_CFO_ROOTS=new Set(['_text','_catalog','_review','_memory','_state','_archive']);
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const exact=(v:any,k:string[])=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===k.slice().sort().join('\0');
const version=(v:unknown):v is string=>typeof v==='string'&&v!=='null'&&/^[^\s\p{C}]{1,1024}$/u.test(v);
const utc=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const path=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024&&v===v.normalize('NFC')&&!/[\\%?#:\u0000-\u001f\u007f]/.test(v)&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..');
function validSourcePolicy(value:unknown):value is Source{
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)return false;const s=value as Json,all=s.source_scope==='all_cfo_source_documents';
 if(!hExactSourcePolicy(s,all)||!path(s.catalog_key)||!s.catalog_key.startsWith('graph-trial/')||!s.catalog_key.endsWith('.jsonl')||!SHA.test(s.catalog_source_sha256)||!Array.isArray(s.source_prefixes))return false;
 if(all)return s.source_prefixes.length===0;
 return s.source_scope===undefined&&s.source_prefixes.length>0&&s.source_prefixes.length<=32&&s.source_prefixes.every((q:any)=>typeof q==='string'&&q.endsWith('/')&&path(q.slice(0,-1)))&&new Set(s.source_prefixes).size===s.source_prefixes.length;
}
function hExactSourcePolicy(s:Json,all:boolean){return exact(s,all?['catalog_key','catalog_source_sha256','source_prefixes','source_scope']:['catalog_key','catalog_source_sha256','source_prefixes']);}
function sourcePathAllowed(source:Source,value:unknown):value is string{
 if(!path(value))return false;
 if(source.source_scope==='all_cfo_source_documents')return !RESERVED_CFO_ROOTS.has(value.split('/')[0].toLowerCase());
 return source.source_prefixes.some(prefix=>value.startsWith(prefix));
}
function validJson(v:any,depth=0):boolean{if(depth>128)return false;if(v===null||typeof v==='boolean'||typeof v==='string')return true;if(typeof v==='number')return Number.isFinite(v);if(Array.isArray(v))return v.every(x=>validJson(x,depth+1));return !!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.values(v).every(x=>validJson(x,depth+1));}
function validRun(r:any){if(!exact(r,['ref_version','run_id','purpose','scope','run_version','manifest_sha256']))return false;const{run_id,...body}=r;return r.ref_version==='neptune-trial-active-run-ref-v1'&&r.scope==='finance'&&LABEL.test(r.purpose)&&LABEL.test(r.run_version)&&SHA.test(r.manifest_sha256)&&run_id==='run_'+hash(canonical(body));}
function validRef(r:any){return exact(r,['key','version_id','sha256'])&&path(r.key)&&version(r.version_id)&&SHA.test(r.sha256);}
function parse(text:string,now:number):Json|null{
 if(text.length>1024*1024)return null;let p:Json;try{p=JSON.parse(text);}catch{return null;}
 if(!exact(p,['schema','policy_version','expires_at','bindings'])||p.schema!=='relationship-history-policy-v1'||!LABEL.test(p.policy_version)||!utc(p.expires_at)||Date.parse(p.expires_at)<=now+1000||!Array.isArray(p.bindings)||!p.bindings.length||p.bindings.length>64)return null;
 const seen=new Set();for(const b of p.bindings){
  if(!exact(b,['authenticated_caller','caller_hash','producer_id','run','encryption','cohort_id','admission','proposal','approved_artifacts','source_policy'])||b.authenticated_caller!=='cfo'||!SHA.test(b.caller_hash)||!PRODUCER.test(b.producer_id)||!validRun(b.run)||!LABEL.test(b.cohort_id)||b.cohort_id==='.'||b.cohort_id==='..'||!validRef(b.admission)||!validRef(b.proposal))return null;
  const prefix=`graph-trial/20260908/catalog-cohorts/${b.cohort_id}/server/`;
  if(b.admission.key!==prefix+`admissions/${b.run.run_id}.json`||!b.proposal.key.startsWith(prefix+'proposals/')||!SHA.test(b.proposal.key.slice((prefix+'proposals/').length,-5))||!b.proposal.key.endsWith('.json'))return null;
  const e=b.encryption;if(!(e?.algorithm==='AES256'&&exact(e,['algorithm'])||e?.algorithm==='aws:kms'&&exact(e,['algorithm','kms_key_id'])&&typeof e.kms_key_id==='string'&&e.kms_key_id.length>0&&e.kms_key_id.length<=1024&&!/[\r\n]/.test(e.kms_key_id)))return null;
  const s=b.source_policy;if(!validSourcePolicy(s))return null;
  if(!Array.isArray(b.approved_artifacts)||!b.approved_artifacts.length||b.approved_artifacts.length>256||!b.approved_artifacts.every((a:any)=>exact(a,['digest','version_id'])&&SHA.test(a.digest)&&version(a.version_id))||new Set(b.approved_artifacts.map((a:any)=>a.digest+'\0'+a.version_id)).size!==b.approved_artifacts.length)return null;
  const id=b.caller_hash+'\0'+b.producer_id+'\0'+b.run.run_id;if(seen.has(id))return null;seen.add(id);
 }return p;
}
function header(h:HistoricalReadResult['headers'],n:string){return h instanceof Headers?h.get(n)??undefined:Object.entries(h).find(([k])=>k.toLowerCase()===n)?.[1];}
function artifactKey(run:string,producer:string,digest:string){return `${BASE}/${run}/relationship-producers/${producer}/resolution-artifacts/sha256/${digest.slice(0,2)}/${digest}.json`;}
function jsonBody(r:HistoricalReadResult,max:number){if(r.body.length>max||!Buffer.from(r.body.toString('utf8')).equals(r.body))throw Error('body');const v=JSON.parse(r.body.toString('utf8'));if(!validJson(v,-1))throw Error('depth');return v;}
async function pinned(d:RelationshipHistoricalReadDeps,ref:Json,signal:AbortSignal){const r=await d.readVersion({key:ref.key,versionId:ref.version_id,signal,maxBytes:512*1024});if(r.status!==200||header(r.headers,'x-amz-version-id')!==ref.version_id||hash(r.body)!==ref.sha256)throw Error('pinned');return jsonBody(r,512*1024);}
function admissionChain(a:Json,p:Json,b:Json){
 if(!exact(a,['allowed','key','run_id','manifest_sha256','max_documents','policy_sha256','decision_sha256'])||a.allowed!==true||a.run_id!==b.run.run_id||a.manifest_sha256!==b.run.manifest_sha256||a.max_documents!==1||!SHA.test(a.policy_sha256)||!SHA.test(a.key))return false;
 const{decision_sha256,...unsigned}=a;if(decision_sha256!==hash(canonical(unsigned)))return false;
 if(!exact(p,['controller_id','key','catalog_snapshot_sha256','catalog_source_sha256','catalog_etag_sha256','manifest','run','max_documents','document_ordinal','paid_fallback','requires_review'])||p.key!==a.key||!same(p.run,b.run)||p.max_documents!==1||p.document_ordinal!==0||p.paid_fallback!==false||p.requires_review!==true||p.catalog_source_sha256!==b.source_policy.catalog_source_sha256||!SHA.test(p.catalog_snapshot_sha256)||!SHA.test(p.catalog_etag_sha256))return false;
 if(b.proposal.key!==`graph-trial/20260908/catalog-cohorts/${b.cohort_id}/server/proposals/${p.key}.json`)return false;
 const controller=hash(canonical({schema:'catalog-controller-v1',room:'finance',catalogSourceSha256:p.catalog_source_sha256,purpose:b.run.purpose,runVersion:b.run.run_version})),m=p.manifest;
 if(p.controller_id!==controller||!exact(m,['version','created_at','documents','manifest_sha256'])||m.version!=='graph-backfill-runner-v1'||!utc(m.created_at)||!Array.isArray(m.documents)||m.documents.length!==1||m.manifest_sha256!==b.run.manifest_sha256)return false;
 const{manifest_sha256,...content}=m;if(hash(canonical(content))!==manifest_sha256)return false;
 const item=m.documents[0];return item?.ordinal===0&&item.room==='finance'&&p.key===hash(canonical({controller_id:controller,document_version_id:item.document_version_id,source_version:item.source_version,enrichment_row_sha256:item.enrichment_row_sha256,extractor_version:item.extractor_version}));
}
function artifactRef(r:any){return exact(r,['schema','artifact_id','bucket','key','payload_sha256','version_id','size_bytes'])&&r.schema==='relationship-resolution-artifact-ref-v1'&&r.bucket===BUCKET&&SHA.test(r.payload_sha256)&&r.artifact_id==='resart_'+r.payload_sha256&&r.key===`resolution-artifacts/sha256/${r.payload_sha256.slice(0,2)}/${r.payload_sha256}.json`&&version(r.version_id)&&Number.isSafeInteger(r.size_bytes)&&r.size_bytes>=0&&r.size_bytes<=MAX_PAYLOAD;}
function parseArtifact(r:HistoricalReadResult,b:Json,digest:string,v:string):Json{
 if(r.status!==200||header(r.headers,'x-amz-version-id')!==v||header(r.headers,'x-amz-meta-resolution-run')!==b.run.run_id||header(r.headers,'x-amz-meta-resolution-producer')!==b.producer_id||header(r.headers,'x-amz-server-side-encryption')!==b.encryption.algorithm||b.encryption.algorithm==='aws:kms'&&header(r.headers,'x-amz-server-side-encryption-aws-kms-key-id')!==b.encryption.kms_key_id)throw Error('artifact');
 const e=jsonBody(r,MAX);if(!exact(e,['schema','payload_sha256','payload'])||e.schema!=='relationship-resolution-artifact-v1'||e.payload_sha256!==digest||!validJson(e.payload)||!same(e.payload?.run,b.run))throw Error('artifact');const content=canonical(e.payload);if(Buffer.byteLength(content)>MAX_PAYLOAD||hash(content)!==digest)throw Error('artifact');
 const p=e.payload;if(p.schema==='resolution-source-input-v1'){if(!exact(p,['schema','run','input']))throw Error('artifact');}else if(p.schema!=='resolution-history-v1'||!exact(p,['schema','run','caller_seat','sources','events','queries'])||p.caller_seat!=='cfo'||!Array.isArray(p.sources)||!p.sources.length||p.sources.length>64||!p.sources.every(artifactRef)||new Set(p.sources.map(canonical)).size!==p.sources.length||!Array.isArray(p.events)||!Array.isArray(p.queries))throw Error('artifact');return e;
}
function sourceBound(source:Json,b:Json,proposal:Json){
 const i=source.payload.input;if(!exact(i,['binding','catalog_row','prepared_text','chunk_start_utf16','chunk_end_utf16','purpose'])||i.purpose!==b.run.purpose)return false;
 const x=i.binding;if(!exact(x,['schema','run_id','room','source_index','catalog_manifest_sha256','document_ordinal','source_document_version','catalog_source_sha256','snapshot_id','prepared_manifest_sha256','sidecar_content_sha256','chunk_ordinal','chunk_sha256'])||x.schema!=='cfo-prepared-chunk-binding-v1'||x.run_id!==b.run.run_id||x.room!=='finance'||x.source_index!=='finance-cfo-source-docs'||x.catalog_manifest_sha256!==b.run.manifest_sha256||x.document_ordinal!==0||!/^txtsnap_[a-f0-9]{64}$/.test(x.snapshot_id)||!SHA.test(x.prepared_manifest_sha256)||!SHA.test(x.sidecar_content_sha256)||!SHA.test(x.chunk_sha256)||!Number.isSafeInteger(x.chunk_ordinal)||x.chunk_ordinal<0)return false;
 const row=i.catalog_row;if(!row||!sourcePathAllowed(b.source_policy,row.path))return false;
 const plan=planGraphCatalogPage({rows:[row],catalogEtag:'historical-projection',catalogSourceSha256:b.source_policy.catalog_source_sha256,createdAt:proposal.manifest.created_at,limit:1});if(!plan.page.manifest||!same(plan.page.manifest,proposal.manifest)||x.source_document_version!==proposal.manifest.documents[0].document_version_id||x.catalog_source_sha256!==proposal.manifest.documents[0].source_version)return false;
 const text=i.prepared_text,start=i.chunk_start_utf16,end=i.chunk_end_utf16;if(typeof text!=='string'||!text.length||Buffer.byteLength(text)>1024*1024||Buffer.from(text).toString('utf8')!==text||hash(text)!==x.sidecar_content_sha256||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end>text.length||end<=start||x.chunk_ordinal===0&&start!==0)return false;const chunk=text.slice(start,end);return chunk.length<=16000&&Buffer.byteLength(chunk)<=16384&&Buffer.from(chunk).toString('utf8')===chunk&&hash(chunk)===x.chunk_sha256;
}
async function defaultSource(row:Json,binding:Json,ctx:AuthContext,signal:AbortSignal,reader=createCfoTextSnapshotReader({callerContext:ctx,maxSourceBytes:1024*1024})){const source=Object.freeze({room:'finance' as const,source_index:'finance-cfo-source-docs' as const,path:row.path,source_path_hash:hash(row.path),document_version_id:binding.source_document_version,source_version:binding.catalog_source_sha256});const result=await reader.readVersionPinnedPage(source,{signal});return result.outcome==='ready'&&result.descriptor.sidecar_content_sha256===binding.sidecar_content_sha256;}
function deps(i?:Partial<RelationshipHistoricalReadDeps>):RelationshipHistoricalReadDeps{const transport=createRelationshipHistoryS3();return{authenticate:i?.authenticate??requireConnectorAuth,policyJson:i?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_HISTORY_POLICY_JSON),now:i?.now??Date.now,readVersion:i?.readVersion??(r=>transport.readVersion(r)),readCatalog:i?.readCatalog??(async(s,signal)=>(await readPinnedGraphCatalog({key:s.catalog_key,sourceSha256:s.catalog_source_sha256,signal})).rows),checkSource:i?.checkSource??defaultSource};}
async function current(d:RelationshipHistoricalReadDeps,b:Json,sources:Json[],ctx:AuthContext,signal:AbortSignal,stages?:{catalog:()=>void;sourceCurrent:()=>void}){stages?.catalog();const rows=await d.readCatalog(b.source_policy,signal);let all=true;for(const source of sources){const i=source.payload.input,row=i.catalog_row,matches=rows.filter((r:any)=>r?.path===row.path);if(matches.length!==1||!sourcePathAllowed(b.source_policy,row.path))throw Error('source_denied');if(!same(matches[0],row)){all=false;continue;}stages?.sourceCurrent();const isCurrent=await d.checkSource(row,i.binding,ctx,signal);all=isCurrent&&all;}return all;}
const fail=(p:FastifyReply,n:number)=>p.code(n).send();
export function registerRelationshipHistoricalReadRoutes(app:FastifyInstance,injected?:Partial<RelationshipHistoricalReadDeps>):void{
 const d=deps(injected);app.get('/relationship-history/v1/:runId/:producerId/sha256/:shard/:digest.json',async(req,reply)=>{
  const internal=new AbortController(),timer=setTimeout(()=>internal.abort(),45000),aborted=()=>internal.abort();req.raw.on('aborted',aborted);const disconnected=()=>{if(!reply.raw.writableFinished)internal.abort();};reply.raw.on('close',disconnected);
  try{
   const p=req.params as Json,q=new URL(req.url,'http://local').searchParams,v=q.get('versionId');if(!/^run_[a-f0-9]{64}$/.test(p.runId)||!PRODUCER.test(p.producerId)||!SHA.test(p.digest)||p.shard!==p.digest.slice(0,2)||q.size!==1||!version(v))return fail(reply,400);
   const ctx=await d.authenticate(req,reply);if(!ctx||ctx.caller_agent!=='cfo'||!ctx.connector_surface||!SHA.test(ctx.caller_hash))return reply.sent?undefined:fail(reply,403);
   const policy=parse(d.policyJson(),d.now());if(!policy)return fail(reply,404);const b=policy.bindings.find((x:Json)=>x.caller_hash===ctx.caller_hash&&x.producer_id===p.producerId&&x.run.run_id===p.runId);if(!b||!b.approved_artifacts.some((a:Json)=>a.digest===p.digest&&a.version_id===v))return fail(reply,403);
   const signal=internal.signal,[admission,proposal]=await Promise.all([pinned(d,b.admission,signal),pinned(d,b.proposal,signal)]);if(!admissionChain(admission,proposal,b))return fail(reply,403);
   const response=await d.readVersion({key:artifactKey(p.runId,p.producerId,p.digest),versionId:v,signal,maxBytes:MAX}),artifact=parseArtifact(response,b,p.digest,v),sources:Json[]=[];
   if(artifact.payload.schema==='resolution-source-input-v1')sources.push(artifact);else for(const ref of artifact.payload.sources){if(!b.approved_artifacts.some((a:Json)=>a.digest===ref.payload_sha256&&a.version_id===ref.version_id))return fail(reply,403);const child=parseArtifact(await d.readVersion({key:artifactKey(p.runId,p.producerId,ref.payload_sha256),versionId:ref.version_id,signal,maxBytes:MAX}),b,ref.payload_sha256,ref.version_id);if(child.payload.schema!=='resolution-source-input-v1'||Buffer.byteLength(canonical(child.payload))!==ref.size_bytes)return fail(reply,403);sources.push(child);}
   if(!sources.every(s=>sourceBound(s,b,proposal)))return fail(reply,403);await current(d,b,sources,ctx,signal);
   const sourceCurrent=await current(d,b,sources,ctx,signal),auth=await d.authenticate(req,reply);if(!auth||auth.caller_agent!==ctx.caller_agent||auth.caller_hash!==ctx.caller_hash||!auth.connector_surface||!same(parse(d.policyJson(),d.now()),policy)||signal.aborted)return reply.sent?undefined:fail(reply,403);
   reply.header('x-relationship-source-current',String(sourceCurrent)).header('x-relationship-policy-version',policy.policy_version).header('x-relationship-policy-expires-at',new Date(Math.min(Date.parse(policy.expires_at),d.now()+120000)).toISOString()).header('x-relationship-producer',b.producer_id).header('x-amz-version-id',v).header('x-amz-server-side-encryption',b.encryption.algorithm);if(b.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',b.encryption.kms_key_id!);return reply.code(200).type('application/json').send(response.body);
  }catch(error){return !reply.sent?fail(reply,(error as Error).message==='source_denied'?403:503):undefined;}finally{clearTimeout(timer);internal.abort();req.raw.off('aborted',aborted);reply.raw.off('close',disconnected);}
 });
}
export const relationshipHistoricalReadTest={canonical,hash,parse,validRun,artifactKey,admissionChain,sourceBound,validSourcePolicy,sourcePathAllowed,defaultSource};

// Shared validation is used by both explicit grants and automatic server publication.
export const relationshipHistoricalAuthority={canonical,hash,parse,validRun,artifactKey,admissionChain,sourceBound,artifactRef,pinned,parseArtifact,current,deps,exact,path,version,utc,validSourcePolicy,sourcePathAllowed};
