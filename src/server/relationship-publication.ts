import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {AuthContext} from '../auth/bearer.js';
import {loadEnv} from '../config/env.js';
import {relationshipHistoricalAuthority as h,type RelationshipHistoricalReadDeps} from './relationship-historical-read.js';
import {resolveRelationshipPublicationAdmission} from './graph-catalog-controller.js';
import {createRelationshipPublicationStore} from './relationship-publication-store.js';
import {queryDurableHistories} from './relationship-query/durable-query.mjs';
import {createProductionRelationshipIdentityCurrentnessResolver,type RelationshipIdentityCurrentnessResolver} from './relationship-identity-currentness.js';
import {companyGraphScopeOwnsBinding,resolveCompanyGraphScope} from './company-graph-scope.js';
import {collectHistoryCandidates,validCandidatePagination} from './candidate-query-pagination.js';

type Json=Record<string,any>;
type Stored={found:boolean;body?:Buffer;versionId?:string};
type Store={get:(id:string,s:AbortSignal)=>Promise<Stored>;putCreateOnly:(r:{runId:string;body:Buffer},s:AbortSignal)=>Promise<Stored>;list:(r:{after?:string;limit:number;signal:AbortSignal})=>Promise<{records:Array<{runId:string;body:Buffer;versionId?:string}>;next?:string}>};
export interface RelationshipPublicationDeps extends Omit<RelationshipHistoricalReadDeps,'policyJson'>{
 policyJson:()=>string;
 storeFor:(cohortId:string,producerId:string)=>Store;
 resolveAdmission:(input:{cohortId:string;run:Json;ctx:AuthContext;signal:AbortSignal})=>Promise<{admission:Json;proposal:Json}>;
 identityCurrentness?:RelationshipIdentityCurrentnessResolver;
}
const SHA=/^[a-f0-9]{64}$/,RUN=/^run_[a-f0-9]{64}$/,LABEL=/^[a-z0-9][a-z0-9_.:-]{0,95}$/,PRODUCER=/^[a-z][a-z0-9-]{0,63}$/;
const FAILURE_STAGES=new Set(['store_get','admission','artifact_read','inspect_pins','inspect_history','inspect_sources','inspect_catalog','inspect_source_current','prewrite','store_put','postwriteinspect','unknown']);
const FAILURE_CODES=new Set(['get','put','size','credentials','deadline','record','conflict','verify','xml','artifact','pinned','source_denied','publication_cancelled','catalog_cancelled','catalog_reader_busy','catalog_head_failed','catalog_changed','catalog_get_failed','catalog_length_changed','catalog_line_too_large','catalog_too_many_rows','catalog_jsonl_invalid','catalog_content_changed','catalog_key_invalid','catalog_credentials','catalog_reader_request_invalid','catalog_timestamp_changed','catalog_version_changed','cfo_text_deadline','cfo_text_source_invalid','cfo_text_chunk_invalid','cfo_text_forbidden','cfo_text_configuration','cfo_text_credentials_unavailable','cfo_text_source_unavailable','unknown']);
const equal=(a:any,b:any)=>h.canonical(a)===h.canonical(b);
function identityCurrentnessMap(proofs:Array<{proof?:Json}>,decisions:Array<unknown>){
 const current=new Map<string,boolean>();
 for(let index=0;index<proofs.length;index++){
  const key=proofs[index]?.proof?.request_sha256;if(!SHA.test(key??''))continue;
  current.set(key,(current.get(key)??true)&&decisions[index]!=null);
 }
 return current;
}
function fail(status=403):never{throw Object.assign(Error('relationship_publication_denied'),{status});}
function failureCode(error:unknown){const value=typeof error==='object'&&error!==null&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:error instanceof Error?error.message:'';return FAILURE_CODES.has(value)?value:'unknown';}
function failureUpstreamStatus(error:unknown){if(!error||typeof error!=='object'||(error as {publicationStoreError?:unknown}).publicationStoreError!==true)return null;const status=(error as {upstreamStatus?:unknown}).upstreamStatus;return typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:null;}
function parse(text:string,now:number):Json|null{
 try{
  if(Buffer.byteLength(text)>65536)return null;const p=JSON.parse(text);
  if(!h.exact(p,['schema','policy_version','expires_at','bindings'])||p.schema!=='relationship-publication-policy-v1'||!LABEL.test(p.policy_version)||!h.utc(p.expires_at)||Date.parse(p.expires_at)<=now+1000||!Array.isArray(p.bindings)||!p.bindings.length||p.bindings.length>32)return null;
  const seen=new Set();for(const b of p.bindings){
   const corporateLegal=b?.authenticated_caller==='clo';
   const keys=['authenticated_caller','caller_hash','producer_id','cohort_id','purpose','run_version','encryption','source_policy',...(corporateLegal?['scope','room','source_index']:[])];
   if(!h.exact(b,keys)||!['cfo','clo'].includes(b.authenticated_caller)||corporateLegal&&(b.scope!=='legal_company'||b.room!=='legal_company'||b.source_index!=='legal-company')||!SHA.test(b.caller_hash)||!PRODUCER.test(b.producer_id)||!LABEL.test(b.cohort_id)||!h.path(b.cohort_id)||!LABEL.test(b.purpose)||!LABEL.test(b.run_version))return null;
   const e=b.encryption;if(!(e?.algorithm==='AES256'&&h.exact(e,['algorithm'])||e?.algorithm==='aws:kms'&&h.exact(e,['algorithm','kms_key_id'])&&typeof e.kms_key_id==='string'&&e.kms_key_id.length>0&&e.kms_key_id.length<=1024&&!/[\r\n]/.test(e.kms_key_id)))return null;
   const s=b.source_policy;if(!h.validSourcePolicy(s))return null;
   const key=b.caller_hash+'/'+b.cohort_id+'/'+b.producer_id;if(seen.has(key))return null;seen.add(key);
  }return p;
 }catch{return null;}
}
function binding(policy:Json,c:Json,g:Json,now:number){
 if(!h.exact(g,['schema','cohort_id','producer_id','caller_hash','run','admission','proposal','artifact_ref','approved_artifacts','issued_under_policy_version'])||g.schema!=='relationship-publication-grant-v1'||g.cohort_id!==c.cohort_id||g.producer_id!==c.producer_id||g.caller_hash!==c.caller_hash||g.run?.purpose!==c.purpose||g.run?.run_version!==c.run_version||!h.artifactRef(g.artifact_ref)||!LABEL.test(g.issued_under_policy_version))fail();
 const b={authenticated_caller:c.authenticated_caller,caller_hash:c.caller_hash,producer_id:c.producer_id,run:g.run,encryption:c.encryption,cohort_id:c.cohort_id,admission:g.admission,proposal:g.proposal,approved_artifacts:g.approved_artifacts,source_policy:c.source_policy};
 if(!h.parse(h.canonical({schema:'relationship-history-policy-v1',policy_version:policy.policy_version,expires_at:policy.expires_at,bindings:[b]}),now))fail();return b;
}
function stored(r:Stored):Json{
 if(!r.found||!r.body||!r.versionId||!h.version(r.versionId)||r.body.length>128*1024||!Buffer.from(r.body.toString('utf8')).equals(r.body))fail(503);
 try{return JSON.parse(r.body!.toString('utf8'));}catch{fail(503);}
}
/** Derive artifact access from the current CFO session and immutable, server-issued catalog records. */
export async function resolveRelationshipArtifactAutomaticBinding(input:{run_id:string;producer_id:string;ctx:AuthContext;signal:AbortSignal},injected?:{policyJson?:()=>string;now?:()=>number;resolveCatalogCohortBinding?:(ctx:AuthContext,runId:string,signal:AbortSignal)=>Promise<any>;resolveRelationshipPublicationAdmission?:(input:{cohortId:string;run:{run_id:string};ctx:AuthContext;signal:AbortSignal})=>Promise<{admission:Json;proposal:Json}>}){
 const now=injected?.now??Date.now,policy=parse((injected?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_PUBLICATION_POLICY_JSON))(),now());
 const scope=resolveCompanyGraphScope(input.ctx.caller_agent,current?.binding?.run?.scope);
 if(!policy||!scope.ok||!input.ctx.connector_surface||!SHA.test(input.ctx.caller_hash)||!RUN.test(input.run_id)||!PRODUCER.test(input.producer_id))return null;
 const catalog=await import('./graph-catalog-controller.js'),current=await (injected?.resolveCatalogCohortBinding??catalog.resolveCatalogCohortBinding)(input.ctx,input.run_id,input.signal);
 if(!current)return null;
 const c=policy.bindings.find((row:Json)=>row.cohort_id===current.cohort_id&&row.caller_hash===input.ctx.caller_hash&&row.producer_id===input.producer_id&&row.authenticated_caller===scope.scope.authenticatedCaller&&row.purpose===current.binding.run.purpose&&row.run_version===current.binding.run.run_version);
 if(!c||!companyGraphScopeOwnsBinding(scope.scope,current.binding)||!equal(c.source_policy,current.source_policy))return null;
 const pins=await (injected?.resolveRelationshipPublicationAdmission??catalog.resolveRelationshipPublicationAdmission)({cohortId:c.cohort_id,run:{run_id:input.run_id},ctx:input.ctx,signal:input.signal});
 return {binding:{authenticated_caller:c.authenticated_caller,caller_hash:input.ctx.caller_hash,producer_id:c.producer_id,run:current.binding.run,encryption:c.encryption},cohort_id:c.cohort_id,policy_version:policy.policy_version,expires_at:policy.expires_at,admission:pins.admission,proposal:pins.proposal,source_policy:c.source_policy};
}
async function bounded<T>(f:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)fail(503);return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(Object.assign(Error('publication_cancelled'),{status:503}));};signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{if(signal.aborted)fail(503);return f();}).then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});if(signal.aborted)abort();});
}
async function inspect(d:RelationshipPublicationDeps,policy:Json,c:Json,g:Json,ctx:AuthContext,signal:AbortSignal,wanted?:string,setStage:(stage:string)=>void=()=>{}){
 const b=binding(policy,c,g,d.now());setStage('inspect_pins');const[a,p]=await Promise.all([h.pinned(d,b.admission,signal),h.pinned(d,b.proposal,signal)]);if(!h.admissionChain(a,p,b))fail();
 const ref=g.artifact_ref;setStage('inspect_history');const r=await d.readVersion({key:h.artifactKey(b.run.run_id,c.producer_id,ref.payload_sha256),versionId:ref.version_id,signal,maxBytes:16*1024*1024+1024}),history=h.parseArtifact(r,b,ref.payload_sha256,ref.version_id);
 if(history.payload.schema!=='resolution-history-v1'||Buffer.byteLength(h.canonical(history.payload))!==ref.size_bytes)fail();
 const approved=[ref,...history.payload.sources].map((x:Json)=>({digest:x.payload_sha256,version_id:x.version_id}));
 if(!equal(g.approved_artifacts,approved))fail();const sources:Json[]=[],responses=new Map<string,typeof r>();if(!wanted||wanted===ref.payload_sha256+'/'+ref.version_id)responses.set(ref.payload_sha256+'/'+ref.version_id,r);
 setStage('inspect_sources');for(const x of history.payload.sources){const response=await d.readVersion({key:h.artifactKey(b.run.run_id,c.producer_id,x.payload_sha256),versionId:x.version_id,signal,maxBytes:16*1024*1024+1024}),s=h.parseArtifact(response,b,x.payload_sha256,x.version_id);if(s.payload.schema!=='resolution-source-input-v1'||Buffer.byteLength(h.canonical(s.payload))!==x.size_bytes||!h.sourceBound(s,b,p))fail();sources.push(s);if(wanted===x.payload_sha256+'/'+x.version_id)responses.set(x.payload_sha256+'/'+x.version_id,response);}
 const currentStages={catalog:()=>setStage('inspect_catalog'),sourceCurrent:()=>setStage('inspect_source_current')};await h.current(d,b,sources,ctx,signal,currentStages);const current=await h.current(d,b,sources,ctx,signal,currentStages);return{current,responses,refresh:()=>h.current(d,b,sources,ctx,signal,currentStages)};
}
async function queryPublishedHistory(d:RelationshipPublicationDeps,policy:Json,c:Json,g:Json,ctx:AuthContext,signal:AbortSignal){
 const b=binding(policy,c,g,d.now()),[admission,proposal]=await Promise.all([h.pinned(d,b.admission,signal),h.pinned(d,b.proposal,signal)]);if(!h.admissionChain(admission,proposal,b))fail();
 const ref=g.artifact_ref,historyArtifact=h.parseArtifact(await d.readVersion({key:h.artifactKey(b.run.run_id,c.producer_id,ref.payload_sha256),versionId:ref.version_id,signal,maxBytes:16*1024*1024+1024}),b,ref.payload_sha256,ref.version_id);
 if(historyArtifact.payload.schema!=='resolution-history-v1'||Buffer.byteLength(h.canonical(historyArtifact.payload))!==ref.size_bytes)fail();
 const sources:Json[]=[];for(const sourceRef of historyArtifact.payload.sources){
  if(!g.approved_artifacts.some((x:Json)=>x.digest===sourceRef.payload_sha256&&x.version_id===sourceRef.version_id))fail();
  const source=h.parseArtifact(await d.readVersion({key:h.artifactKey(b.run.run_id,c.producer_id,sourceRef.payload_sha256),versionId:sourceRef.version_id,signal,maxBytes:16*1024*1024+1024}),b,sourceRef.payload_sha256,sourceRef.version_id);
  if(source.payload.schema!=='resolution-source-input-v1'||Buffer.byteLength(h.canonical(source.payload))!==sourceRef.size_bytes||!h.sourceBound(source,b,proposal))fail();sources.push(source);
 }
 const current=await h.current(d,b,sources,ctx,signal);
 const authorization={allowed:true,provenance:{decision_source:'authenticated_gateway',policy_version:policy.policy_version,allowed_roles:['cfo']},decision_ref:`relationship-publication:${c.producer_id}:${policy.policy_version}`,expires_at:new Date(Math.min(Date.parse(policy.expires_at),d.now()+120000)).toISOString()};
 return {entry:{history:historyArtifact.payload,inputs:sources.map(source=>source.payload.input),authorization,sourceCurrent:current},refresh:()=>h.current(d,b,sources,ctx,signal)};
}
function publicationDeps(injected?:Partial<RelationshipPublicationDeps>):RelationshipPublicationDeps{
 const base=h.deps(injected);return{...base,policyJson:injected?.policyJson??(()=>loadEnv().GRAPH_RELATIONSHIP_PUBLICATION_POLICY_JSON),storeFor:injected?.storeFor??((cohort,producer)=>createRelationshipPublicationStore({cohort,producer})),resolveAdmission:injected?.resolveAdmission??(r=>resolveRelationshipPublicationAdmission({...r,run:{run_id:r.run.run_id}})),identityCurrentness:injected?.identityCurrentness??createProductionRelationshipIdentityCurrentnessResolver()};
}
function budgeted(d:RelationshipPublicationDeps):RelationshipPublicationDeps{
 const budgets=new WeakMap<AbortSignal,{bytes:number;reads:number}>(),rawRead=d.readVersion;
 return{...d,readVersion:async r=>{const budget=budgets.get(r.signal)??{bytes:0,reads:0};budgets.set(r.signal,budget);if(r.signal.aborted||++budget.reads>2048||budget.bytes>=128*1024*1024)fail(503);const result=await rawRead({...r,maxBytes:Math.min(r.maxBytes,128*1024*1024-budget.bytes)});budget.bytes+=result.body.length;if(budget.bytes>128*1024*1024||r.signal.aborted)fail(503);return result;}};
}
function validQuery(query:Json):boolean{
 if(!query||Object.getPrototypeOf(query)!==Object.prototype)return false;const keys=Object.keys(query);
 return query.kind==='candidate_links'?validCandidatePagination(query)&&keys.every(k=>['kind','subject_name','object_name','predicate','offset','limit','include_stale'].includes(k)):keys.every(k=>['subject_id','object_id','premise_ids','as_of_recorded','valid_at'].includes(k))&&Object.hasOwn(query,'subject_id')&&Object.hasOwn(query,'object_id');
}
async function queryEntries(d:RelationshipPublicationDeps,policy:Json,ctx:AuthContext,signal:AbortSignal,loaded:Array<Awaited<ReturnType<typeof queryPublishedHistory>>>,query:Json,recheck:()=>Promise<void>){
 const entries=loaded.map(result=>result.entry),preliminary=queryDurableHistories({entries,query,now:d.now}),proofs=(preliminary as any).identityProofs as Array<{request:unknown;proof:Json}>,uniqueProofs=[...new Map(proofs.map(item=>[h.canonical(item),item])).values()];
 const revalidate=async()=>d.identityCurrentness?await Promise.all(uniqueProofs.map(item=>d.identityCurrentness!.revalidate(item.request,item.proof,ctx,{signal}))):uniqueProofs.map(()=>null),before=identityCurrentnessMap(uniqueProofs,await revalidate()),answer=queryDurableHistories({entries,query,now:d.now,identityCurrentness:before});
 await recheck();for(const result of loaded)if((await result.refresh())!==result.entry.sourceCurrent)fail();const after=identityCurrentnessMap(uniqueProofs,await revalidate());for(const [key,wasCurrent] of before)if(wasCurrent&&after.get(key)!==true)fail();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();return answer;
}
export type RelationshipPublicationDiscoveryInput={cohort_id:string;producer_id:string;scope?:string;after?:string;scan_limit?:number;history_limit?:number;query:Json};
export type RelationshipPublicationDiscoveryService={query:(input:RelationshipPublicationDiscoveryInput,ctx:AuthContext,signal:AbortSignal,recheck?:()=>Promise<void>)=>Promise<Json>};
type IndexedRecord={record:Json;history:number};
function indexEntry(entry:Json,history:number):{records:IndexedRecord[];corrections:Array<{correction:Json;history:number}>}{
 queryDurableHistories({entries:[entry],query:{kind:'candidate_links',include_stale:true,limit:1},now:()=>0});
 const records:IndexedRecord[]=[],corrections:Array<{correction:Json;history:number}>=[];for(const event of entry.history.events){if(event.operation==='accept')records.push({record:event.output,history});else if(event.operation==='supersede')corrections.push({correction:event.output,history});}return{records,corrections};
}
function relevantVerifiedHistories(records:IndexedRecord[],corrections:Array<{correction:Json;history:number}>,query:Json):Set<number>{
 const byId=new Map(records.map(item=>[item.record.record_id,item])),positive=records.filter(item=>item.record?.accepted===true&&item.record?.polarity==='positive'&&item.record?.candidate?.predicate==='depends_on'&&item.record?.subject?.status==='resolved'&&item.record?.object?.status==='resolved');
 let ids=new Set<string>();if(Array.isArray(query.premise_ids)){for(const id of query.premise_ids)ids.add(id);}else{
  const forward=new Map<string,number>([[query.subject_id,0]]),reverse=new Map<string,number>([[query.object_id,0]]);for(let depth=0;depth<4;depth++){for(const item of positive){const a=item.record.subject.entity_id,b=item.record.object.entity_id;if(forward.get(a)===depth&&!forward.has(b))forward.set(b,depth+1);if(reverse.get(b)===depth&&!reverse.has(a))reverse.set(a,depth+1);}}
  for(const item of positive){const a=forward.get(item.record.subject.entity_id),b=reverse.get(item.record.object.entity_id);if(a!==undefined&&b!==undefined&&a+b+1<=4)ids.add(item.record.record_id);}
  if(!ids.size)for(const item of records)if(item.record?.subject?.entity_id===query.subject_id||item.record?.object?.entity_id===query.object_id)ids.add(item.record.record_id);
 }
 const claims=new Set(records.filter(item=>ids.has(item.record.record_id)).map(item=>item.record.claim_key));for(const item of records)if(claims.has(item.record.claim_key))ids.add(item.record.record_id);
 let changed=true;while(changed){changed=false;for(const item of corrections){const c=item.correction;if(ids.has(c?.target_id)||ids.has(c?.replacement_id)){for(const id of[c.target_id,c.replacement_id])if(typeof id==='string'&&!ids.has(id)){ids.add(id);changed=true;}}}}
 const histories=new Set<number>();for(const id of ids){const item=byId.get(id);if(item)histories.add(item.history);}for(const item of corrections)if(ids.has(item.correction?.target_id)||ids.has(item.correction?.replacement_id))histories.add(item.history);return histories;
}
/** Server-owned publication discovery. Index pages are bounded and every selected history is replayed before use. */
export function createRelationshipPublicationDiscoveryService(injected?:Partial<RelationshipPublicationDeps>):RelationshipPublicationDiscoveryService{
 const d=budgeted(publicationDeps(injected));return{query:async(input,ctx,signal,recheck=async()=>{})=>{
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||!h.exact(input,['cohort_id','producer_id','query',...(input.scope===undefined?[]:['scope']),...(input.after===undefined?[]:['after']),...(input.scan_limit===undefined?[]:['scan_limit']),...(input.history_limit===undefined?[]:['history_limit'])])||!LABEL.test(input.cohort_id)||!h.path(input.cohort_id)||!PRODUCER.test(input.producer_id)||input.after!==undefined&&!RUN.test(input.after)||!validQuery(input.query)||Buffer.byteLength(h.canonical(input))>16384)fail(400);
  const limit=input.scan_limit??64,historyLimit=input.history_limit??256;if(!Number.isInteger(limit)||limit<1||limit>64||!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>256||!ctx.connector_surface||!SHA.test(ctx.caller_hash))fail();
  const scope=resolveCompanyGraphScope(ctx.caller_agent,input.scope);if(!scope.ok)fail();
  const policy=parse(d.policyJson(),d.now());if(!policy)fail(404);const c=policy.bindings.find((x:Json)=>x.cohort_id===input.cohort_id&&x.producer_id===input.producer_id&&x.caller_hash===ctx.caller_hash&&x.authenticated_caller===scope.scope.authenticatedCaller);if(!c)fail();
  const refs:Json[]=[],loaded:Array<Awaited<ReturnType<typeof queryPublishedHistory>>>=[],records:IndexedRecord[]=[],corrections:Array<{correction:Json;history:number}>=[];let cursor=input.after,last=cursor??'',next:string|undefined;
  do{const page=await d.storeFor(c.cohort_id,c.producer_id).list({after:cursor,limit:Math.min(limit,historyLimit-loaded.length),signal});if(page.records.length>limit)fail(503);for(const row of page.records){const g=stored({found:true,...row});binding(policy,c,g,d.now());if(g.run.run_id!==row.runId||row.runId<=last)fail(503);last=row.runId;const item=await queryPublishedHistory(d,policy,c,g,ctx,signal);if(!item.entry.inputs.every((source:Json)=>companyGraphScopeOwnsBinding(scope.scope,{authenticated_caller:c.authenticated_caller,room:source.binding?.room,source_index:source.binding?.source_index,run:g.run})))fail();refs.push({run_id:g.run.run_id,artifact_ref:g.artifact_ref});loaded.push(item);const indexed=indexEntry(item.entry,loaded.length-1);records.push(...indexed.records);corrections.push(...indexed.corrections);}next=page.next;if(next!==undefined&&(next!==last||!page.records.length))fail(503);cursor=next;}while(next!==undefined&&loaded.length<historyLimit);
  await recheck();for(const result of loaded)if((await result.refresh())!==result.entry.sourceCurrent)fail();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();const complete=next===undefined&&input.after===undefined;
  let answer:Json,selected:number[]=[];if(!loaded.length)answer=input.query.kind==='candidate_links'?{status:'unverified_candidates',epistemic_status:'candidate',semantic_verified:false,conclusion:null,query_scope:'publication_history',matching:'exact_literal_names_not_entity_identity',items:[],total:0,next_offset:null}:{status:'unsupported',reason:'no_published_histories',conclusion:null,evidence:[]};else if(input.query.kind==='candidate_links'){
   const items:Json[]=[];for(let index=0;index<loaded.length;index++){const part=await collectHistoryCandidates<Json>(async offset=>{const result=await queryEntries(d,policy,ctx,signal,[loaded[index]],{...input.query,offset,limit:100},recheck);return {items:result.items,total:result.total,next_offset:result.next_offset};});items.push(...part);selected.push(index);}items.sort((a,b)=>String(a.record_id).localeCompare(String(b.record_id)));const offset=input.query.offset??0,count=input.query.limit??100;answer={status:'unverified_candidates',epistemic_status:'candidate',semantic_verified:false,conclusion:null,query_scope:complete?'complete_publication_history':'bounded_publication_history',matching:'exact_literal_names_not_entity_identity',items:items.slice(offset,offset+count),total:items.length,next_offset:offset+count<items.length?offset+count:null};
  }else if(!complete)answer={status:'incomplete',reason:'publication_history_limit_reached',conclusion:null,evidence:[],semantic_verified:false};else{
   selected=[...relevantVerifiedHistories(records,corrections,input.query)].sort((a,b)=>a-b);if(selected.length>64)answer={status:'incomplete',reason:'relevant_history_limit_exceeded',conclusion:null,evidence:[],semantic_verified:false};else if(!selected.length)answer={status:'unsupported',reason:'no_accepted_dependency_path',conclusion:null,evidence:[]};else answer=await queryEntries(d,policy,ctx,signal,selected.map(index=>loaded[index]),input.query,recheck);
  }
  await recheck();for(const result of loaded)if((await result.refresh())!==result.entry.sourceCurrent)fail();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();
  return{schema:'relationship-publication-discovery-query-v1',discovery:{schema:'relationship-publication-history-index-page-v1',history_refs:selected.map(index=>refs[index]),scanned_histories:refs.length,queried_histories:selected.length,next_after:next??null,scan_complete:complete},answer};
 }};
}
export function registerRelationshipPublicationRoutes(app:FastifyInstance,injected?:Partial<RelationshipPublicationDeps>){
 const d=budgeted(publicationDeps(injected)),discovery=createRelationshipPublicationDiscoveryService(d);
 const prefix='/relationship-publications/v1/:cohortId/:producerId';
 const route=(method:'GET'|'POST',url:string,operation:(r:FastifyRequest,p:FastifyReply,c:Json,policy:Json,ctx:AuthContext,s:AbortSignal,recheck:()=>Promise<void>,setStage:(stage:string)=>void)=>Promise<any>)=>app.route({method,url,bodyLimit:16384,handler:async(req,reply)=>{
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),45000),abort=()=>ctl.abort(),close=()=>{if(!reply.raw.writableFinished)ctl.abort();};req.raw.on('aborted',abort);reply.raw.on('close',close);
  let authenticatedBinding=false,stage='unknown';const setStage=(value:string)=>{stage=FAILURE_STAGES.has(value)?value:'unknown';};
  try{
   const params=req.params as Json;if(!LABEL.test(params.cohortId)||!h.path(params.cohortId)||!PRODUCER.test(params.producerId))fail(400);
   const ctx=await bounded(()=>d.authenticate(req,reply),ctl.signal);if(!ctx||ctx.caller_agent!=='cfo'||!ctx.connector_surface||!SHA.test(ctx.caller_hash))fail();
   const policy=parse(d.policyJson(),d.now());if(!policy)fail(404);const c=policy.bindings.find((x:Json)=>x.cohort_id===params.cohortId&&x.producer_id===params.producerId&&x.caller_hash===ctx.caller_hash);if(!c)fail();authenticatedBinding=true;
   const recheck=async()=>{const auth=await d.authenticate(req,reply);if(!auth||auth.caller_agent!=='cfo'||!auth.connector_surface||auth.caller_hash!==ctx.caller_hash||!equal(parse(d.policyJson(),d.now()),policy)||ctl.signal.aborted)fail();};
   return await bounded(()=>operation(req,reply,c,policy,ctx,ctl.signal,recheck,setStage),ctl.signal);
  }catch(e){if(!reply.sent){if(authenticatedBinding&&method==='POST'){reply.header('x-relationship-failure-stage',stage).header('x-relationship-failure-code',failureCode(e));const upstreamStatus=failureUpstreamStatus(e);if(upstreamStatus!==null)reply.header('x-relationship-failure-upstream-status',String(upstreamStatus));}return reply.code((e as any).status??((e as Error).message==='source_denied'?403:503)).send();}}finally{clearTimeout(timer);ctl.abort();req.raw.off('aborted',abort);reply.raw.off('close',close);}
 }});
 route('POST',prefix,async(req,reply,c,policy,ctx,signal,recheck,setStage)=>{
  if(new URL(req.url,'http://local').search)fail(400);const input=req.body as Json;if(!h.exact(input,['run','artifact_ref'])||!h.validRun(input.run)||!h.artifactRef(input.artifact_ref)||input.run.purpose!==c.purpose||input.run.run_version!==c.run_version)fail(400);
  const store=d.storeFor(c.cohort_id,c.producer_id);setStage('store_get');const existing=await store.get(input.run.run_id,signal);let grant:Json;
  if(existing.found){grant=stored(existing);if(!equal(grant.run,input.run)||!equal(grant.artifact_ref,input.artifact_ref))fail(409);}
  else{
   setStage('admission');const pins=await d.resolveAdmission({cohortId:c.cohort_id,run:input.run,ctx,signal}),ref=input.artifact_ref;
   grant={schema:'relationship-publication-grant-v1',cohort_id:c.cohort_id,producer_id:c.producer_id,caller_hash:ctx.caller_hash,run:input.run,...pins,artifact_ref:ref,approved_artifacts:[{digest:ref.payload_sha256,version_id:ref.version_id}],issued_under_policy_version:policy.policy_version};
   const b=binding(policy,c,grant,d.now());setStage('artifact_read');const r=await d.readVersion({key:h.artifactKey(input.run.run_id,c.producer_id,ref.payload_sha256),versionId:ref.version_id,signal,maxBytes:16*1024*1024+1024}),history=h.parseArtifact(r,b,ref.payload_sha256,ref.version_id);if(history.payload.schema!=='resolution-history-v1')fail();grant.approved_artifacts.push(...history.payload.sources.map((x:Json)=>({digest:x.payload_sha256,version_id:x.version_id})));
  }
  setStage('inspect_pins');if(!(await inspect(d,policy,c,grant,ctx,signal,undefined,setStage)).current)fail();setStage('prewrite');await recheck();
  setStage('store_put');const saved=stored(await store.putCreateOnly({runId:input.run.run_id,body:Buffer.from(h.canonical(grant))},signal));if(!equal(saved,grant))fail(409);setStage('postwriteinspect');await recheck();if(!(await inspect(d,policy,c,grant,ctx,signal,undefined,setStage)).current)fail();await recheck();
  return reply.code(200).send({schema:'relationship-publication-receipt-v1',item:{run:grant.run,producer_id:c.producer_id,artifact_ref:grant.artifact_ref}});
 });
 route('GET',prefix,async(req,reply,c,policy,ctx,signal,recheck)=>{
  const q=new URL(req.url,'http://local').searchParams,after=q.get('after')??undefined,limit=q.has('limit')?Number(q.get('limit')):64;if([...q.keys()].some(k=>!['after','limit'].includes(k))||new Set(q.keys()).size!==q.size||after!==undefined&&!RUN.test(after)||!Number.isInteger(limit)||limit<1||limit>64)fail(400);
  const page=await d.storeFor(c.cohort_id,c.producer_id).list({after,limit,signal});if(page.records.length>limit)fail(503);let last=after??'';
  const items=[],refreshes:Array<()=>Promise<boolean>>=[];for(const r of page.records){const g=stored({found:true,...r});binding(policy,c,g,d.now());if(g.run.run_id!==r.runId||r.runId<=last)fail(503);last=r.runId;refreshes.push((await inspect(d,policy,c,g,ctx,signal)).refresh);items.push({run:g.run,producer_id:c.producer_id,artifact_ref:g.artifact_ref});}if(page.next!==undefined&&(page.next!==last||!items.length))fail(503);await recheck();for(const refresh of refreshes)await refresh();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();return reply.send({schema:'relationship-publication-page-v1',items,next_after:page.next??null});
 });
 route('POST',prefix+'/query',async(req,reply,c,policy,ctx,signal,recheck)=>{
  if(new URL(req.url,'http://local').search)fail(400);const input=req.body as Json;
   if(!h.exact(input,['histories','query'])||!Array.isArray(input.histories)||!input.histories.length||input.histories.length>64||!validQuery(input.query)||Buffer.byteLength(h.canonical(input))>16384)fail(400);
  const seen=new Set<string>(),items:Json[]=[];for(const item of input.histories){if(!h.exact(item,['run_id','artifact_ref'])||!RUN.test(item.run_id)||!h.artifactRef(item.artifact_ref)||seen.has(item.run_id+'\0'+h.canonical(item.artifact_ref)))fail(400);seen.add(item.run_id+'\0'+h.canonical(item.artifact_ref));items.push(item);}
  const loaded=[];for(const item of items){const g=stored(await d.storeFor(c.cohort_id,c.producer_id).get(item.run_id,signal));binding(policy,c,g,d.now());if(g.run.run_id!==item.run_id||!equal(g.artifact_ref,item.artifact_ref))fail();loaded.push(await queryPublishedHistory(d,policy,c,g,ctx,signal));}
   const answer=await queryEntries(d,policy,ctx,signal,loaded,input.query,recheck);
   return reply.send({schema:'relationship-publication-query-v1',history_refs:items.map(item=>item.artifact_ref),answer});
  });
  route('POST',prefix+'/discover-query',async(req,reply,c,_policy,ctx,signal,recheck)=>{
   if(new URL(req.url,'http://local').search)fail(400);const body=req.body as Json;if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).some(key=>!['scope','after','scan_limit','history_limit','query'].includes(key))||!Object.hasOwn(body,'query'))fail(400);
   const result=await discovery.query({cohort_id:c.cohort_id,producer_id:c.producer_id,...body} as RelationshipPublicationDiscoveryInput,ctx,signal,recheck);return reply.send(result);
  });
 route('GET',prefix+'/artifacts/:runId/sha256/:shard/:digest.json',async(req,reply,c,policy,ctx,signal,recheck)=>{
  const p=req.params as Json,q=new URL(req.url,'http://local').searchParams,v=q.get('versionId');if(!RUN.test(p.runId)||!SHA.test(p.digest)||p.shard!==p.digest.slice(0,2)||q.size!==1||!h.version(v))fail(400);
  const g=stored(await d.storeFor(c.cohort_id,c.producer_id).get(p.runId,signal));binding(policy,c,g,d.now());if(g.run.run_id!==p.runId||!g.approved_artifacts.some((x:Json)=>x.digest===p.digest&&x.version_id===v))fail();const checked=await inspect(d,policy,c,g,ctx,signal,p.digest+'/'+v),response=checked.responses.get(p.digest+'/'+v);if(!response)fail();await recheck();const sourceCurrent=await checked.refresh();if(!equal(parse(d.policyJson(),d.now()),policy)||signal.aborted)fail();
  reply.header('x-relationship-source-current',String(sourceCurrent)).header('x-relationship-policy-version',policy.policy_version).header('x-relationship-policy-expires-at',new Date(Math.min(Date.parse(policy.expires_at),d.now()+120000)).toISOString()).header('x-relationship-producer',c.producer_id).header('x-amz-version-id',v).header('x-amz-server-side-encryption',c.encryption.algorithm);if(c.encryption.algorithm==='aws:kms')reply.header('x-amz-server-side-encryption-aws-kms-key-id',c.encryption.kms_key_id);return reply.type('application/json').send(response!.body);
 });
}
export const relationshipPublicationTest={parse,binding,identityCurrentnessMap};
