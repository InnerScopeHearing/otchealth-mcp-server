/** Default-disabled CFO cohort authority. Writable client progress never grants access. */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireConnectorAuth, type AuthContext } from '../auth/bearer.js';
import { loadEnv } from '../config/env.js';
import { canonicalUri, resolveAwsCredentials, signRequest } from '../search/sigv4.js';
import { planGraphCatalogPage } from './graph-catalog-planner.js';
import { defaultGraphCatalogS3, readPinnedGraphCatalog, type GraphCatalogRawS3 } from './graph-catalog-reader.js';
import { CFO_SOURCE_CATALOG_KEY, MATERIALIZED_CATALOG_PREFIX, parseMaterializationPin, verifyMaterializationReceipt, type MaterializationPin } from './materialized-catalog-pin.js';
const BASE='graph-trial/20260908/catalog-cohorts', SOURCE='graph-trial/20260908/source-pilot/snapshots';
const WORKERS='graph-trial/20260908/workers/cfo',BUCKET='otchealth-finance-legal-dr-55c84f6b',REGION='us-east-1';
const SHA=/^[a-f0-9]{64}$/, ID=/^[a-z0-9][a-z0-9_.:-]{0,95}$/, ETAG=/^"[A-Za-z0-9-]{1,128}"$/,MAX=512*1024;
type Json=Record<string,any>;
type Raw={method:'GET'|'PUT';key:string;headers?:Record<string,string>;body?:Buffer;signal:AbortSignal};
type SourceHeadRaw={method:'HEAD';key:string;signal:AbortSignal};
type Res={status:number;headers:Headers;body:Buffer};
type Run={ref_version:string;run_id:string;purpose:string;scope:string;run_version:string;manifest_sha256:string};
type Binding={authenticated_caller:'cfo';run:Run;room:'finance';source_index:'finance-cfo-source-docs'};
type Cfg={cohort_id:string;catalog_key:string;catalog_source_sha256:string;source_prefixes:string[];source_scope?:'all_cfo_source_documents';purpose:string;run_version:string;batch_size:number;max_admissions:number;policy_sha256:string;expires_at:string;recovery_policy_sha256?:string;recovery_expires_at?:string;materialization?:MaterializationPin};
export interface GraphCatalogDeps{authenticate:(r:FastifyRequest,p:FastifyReply)=>Promise<AuthContext|undefined>;configs:()=>string;s3:(r:Raw)=>Promise<Res>;sourceHead?:(r:SourceHeadRaw)=>Promise<Res>;now:()=>number;catalogS3?:GraphCatalogRawS3;}
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const equal=(a:any,b:any)=>canonical(a)===canonical(b);
const exact=(v:any,k:string[])=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===k.slice().sort().join('\0');
const path=(c:Cfg,s:string)=>`${BASE}/${c.cohort_id}/${s}`;
const validPath=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=1024&&s===s.normalize('NFC')&&!s.startsWith('/')&&!/[\\%?#:\u0000-\u001f\u007f]/.test(s)&&s.split('/').every(p=>p!==''&&p!=='.'&&p!=='..');
function fail(status=503,code='graph_catalog_unavailable'):never{throw Object.assign(new Error(code),{status,code});}
function active(signal:AbortSignal){if(signal.aborted)fail(503,'graph_catalog_cancelled');}
async function bounded<T>(fn:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 active(signal);return new Promise((resolve,reject)=>{const cleanup=()=>signal.removeEventListener('abort',abort);const abort=()=>{cleanup();reject(Object.assign(new Error('graph_catalog_cancelled'),{status:503,code:'graph_catalog_cancelled'}));};signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{active(signal);return fn();}).then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});if(signal.aborted)abort();});
}
function configFor(text:string,id:string):Cfg|null{
 try{if(text.length>65536)return null;const all=JSON.parse(text);if(!Array.isArray(all)||all.length>32)return null;const found=all.filter(x=>x?.cohort_id===id);if(found.length!==1)return null;const c=found[0],keys=['cohort_id','catalog_key','catalog_source_sha256','source_prefixes','purpose','run_version','batch_size','max_admissions','policy_sha256','expires_at'];
 const recovery=['recovery_policy_sha256','recovery_expires_at'],materialization=['materialization'],scope=['source_scope'];
 if(![keys,[...keys,...recovery],[...keys,...materialization],[...keys,...recovery,...materialization],[...keys,...scope],[...keys,...scope,...materialization],[...keys,...scope,...recovery],[...keys,...scope,...recovery,...materialization]].some(shape=>exact(c,shape)))return null;
 const date=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
 if(!ID.test(c.cohort_id)||!validPath(c.catalog_key)||!c.catalog_key.startsWith('graph-trial/')||!c.catalog_key.endsWith('.jsonl')||!SHA.test(c.catalog_source_sha256)||!ID.test(c.purpose)||!ID.test(c.run_version)||!SHA.test(c.policy_sha256)||!date(c.expires_at)||!Number.isInteger(c.batch_size)||c.batch_size<1||c.batch_size>10||!Number.isInteger(c.max_admissions)||c.max_admissions<0||c.max_admissions>1000||!Array.isArray(c.source_prefixes))return null;
 const allScope=c.source_scope==='all_cfo_source_documents';
 if(c.source_scope!==undefined&&!allScope)return null;
  const invalidPrefixes = c.source_prefixes.length<1 || c.source_prefixes.length>16 ||
    !c.source_prefixes.every((p:any)=>typeof p==='string'&&p.endsWith('/')&&validPath(p.slice(0,-1))) ||
    new Set(c.source_prefixes).size!==c.source_prefixes.length;
  if(allScope ? c.source_prefixes.length!==0 : invalidPrefixes)return null;
 if(c.recovery_policy_sha256!==undefined&&(!SHA.test(c.recovery_policy_sha256)||!date(c.recovery_expires_at)))return null;
 const pin=c.materialization===undefined?undefined:parseMaterializationPin(c.materialization);
 if(c.materialization!==undefined&&!pin)return null;
 if(c.catalog_key.startsWith(MATERIALIZED_CATALOG_PREFIX)!==!!pin||allScope&&!pin)return null;
 if(pin)c.materialization=pin;
 return c;}catch{return null;}
}
async function defaultS3(r:Raw):Promise<Res>{
 if(!r.key.startsWith('graph-trial/'))fail(403,'graph_catalog_forbidden');
 active(r.signal);const credentials=await bounded(()=>resolveAwsCredentials(),r.signal);if(!credentials)fail();active(r.signal);
 const host=`${BUCKET}.s3.${REGION}.amazonaws.com`,signed=signRequest({method:r.method,host,path:'/'+r.key,region:REGION,service:'s3',credentials,...(r.body?{body:r.body}:{}),extraHeaders:{'x-amz-content-sha256':hash(r.body??Buffer.alloc(0)),...(r.headers??{})}});
 const response=await bounded(()=>fetch('https://'+host+canonicalUri('/'+r.key),{method:r.method,headers:signed.headers,body:r.body,signal:r.signal,redirect:'error'}),r.signal);
 if(Number(response.headers.get('content-length'))>MAX)fail();const reader=response.body?.getReader(),parts:Buffer[]=[];let size=0;
 try{if(reader)for(;;){const x=await bounded(()=>reader.read(),r.signal);active(r.signal);if(x.done)break;size+=x.value.byteLength;if(size>MAX)fail();parts.push(Buffer.from(x.value));}return{status:response.status,headers:response.headers,body:Buffer.concat(parts,size)};}
 finally{if(reader){let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([reader.cancel().catch(()=>undefined),new Promise(resolve=>{timer=setTimeout(resolve,100);})]);clearTimeout(timer);}}
}
async function defaultSourceHead(r:SourceHeadRaw):Promise<Res>{
 if(r.key!==CFO_SOURCE_CATALOG_KEY)fail(403,'graph_catalog_forbidden');active(r.signal);const credentials=await bounded(()=>resolveAwsCredentials(),r.signal);if(!credentials)fail();
 const host=`${BUCKET}.s3.${REGION}.amazonaws.com`,signed=signRequest({method:'HEAD',host,path:'/'+r.key,region:REGION,service:'s3',credentials,extraHeaders:{'x-amz-content-sha256':hash(Buffer.alloc(0))}});
 const response=await bounded(()=>fetch('https://'+host+canonicalUri('/'+r.key),{method:'HEAD',headers:signed.headers,signal:r.signal,redirect:'error'}),r.signal);
 return {status:response.status,headers:response.headers,body:Buffer.alloc(0)};
}
function depsOf(i?:Partial<GraphCatalogDeps>):GraphCatalogDeps{return{authenticate:i?.authenticate??requireConnectorAuth,configs:i?.configs??(()=>loadEnv().GRAPH_CATALOG_COHORTS_JSON),s3:i?.s3??defaultS3,sourceHead:i?.sourceHead??defaultSourceHead,now:i?.now??Date.now,catalogS3:i?.catalogS3};}
async function get(d:GraphCatalogDeps,k:string,s:AbortSignal):Promise<{value:Json;etag:string;raw:Res}|null>{
 const r=await bounded(()=>d.s3({method:'GET',key:k,signal:s}),s);active(s);if(r.status===404)return null;if(r.status!==200||r.body.length>MAX||!ETAG.test(r.headers.get('etag')??''))fail();let v;try{v=JSON.parse(r.body.toString('utf8'));}catch{fail();}if(!v||typeof v!=='object'||Array.isArray(v))fail();return{value:v,etag:r.headers.get('etag')!,raw:r};
}
async function cas(d:GraphCatalogDeps,k:string,prior:{etag:string}|null,v:any,s:AbortSignal):Promise<boolean>{
 active(s);const body=Buffer.from(canonical(v));if(body.length>MAX)fail(400,'graph_catalog_request_invalid');const r=await bounded(()=>d.s3({method:'PUT',key:k,headers:{'content-type':'application/json',...(prior?{'if-match':prior.etag}:{'if-none-match':'*'})},body,signal:s}),s);active(s);if([409,412].includes(r.status))return false;if(![200,201].includes(r.status))fail();const saved=await get(d,k,s);if(!saved||!equal(saved.value,v))fail();return true;
}
async function immutable(d:GraphCatalogDeps,k:string,v:any,s:AbortSignal){const old=await get(d,k,s);if(old){if(!equal(old.value,v))fail(409,'graph_catalog_immutable_conflict');return;}await cas(d,k,null,v,s);const saved=await get(d,k,s);if(!saved||!equal(saved.value,v))fail();}
function controllerId(c:Cfg){return hash(canonical({schema:'catalog-controller-v1',room:'finance',catalogSourceSha256:c.catalog_source_sha256,purpose:c.purpose,runVersion:c.run_version}));}
function run(c:Cfg,m:string):Run{const x={ref_version:'neptune-trial-active-run-ref-v1',purpose:c.purpose,scope:'finance',run_version:c.run_version,manifest_sha256:m};return{...x,run_id:'run_'+hash(canonical(x))};}
function validItem(x:any){return exact(x,['ordinal','room','document_version_id','source_version','source_path_hash','enrichment_row_sha256','extractor_version','retract_event_ids'])&&x.ordinal===0&&x.room==='finance'&&/^docv_[a-f0-9]{64}$/.test(x.document_version_id)&&['source_version','source_path_hash','enrichment_row_sha256'].every(k=>SHA.test(x[k]))&&x.extractor_version==='catalog-mention-snapshot-v1'&&Array.isArray(x.retract_event_ids)&&x.retract_event_ids.length===0;}
function validManifest(m:any){if(!exact(m,['version','created_at','documents','manifest_sha256'])||m.version!=='graph-backfill-runner-v1'||!Array.isArray(m.documents)||m.documents.length!==1||!validItem(m.documents[0])||!SHA.test(m.manifest_sha256))return false;const{manifest_sha256,...body}=m;return manifest_sha256===hash(canonical(body));}
async function sourceHead(d:GraphCatalogDeps,expectedVersion:string,s:AbortSignal){
 const raw=await bounded(()=>(d.sourceHead??defaultSourceHead)({method:'HEAD',key:CFO_SOURCE_CATALOG_KEY,signal:s}),s),version=raw.headers.get('x-amz-version-id');
 if(raw.status!==200||version!==expectedVersion)fail(409,'graph_catalog_source_changed');
 return version;
}
function sourceRowAllowed(c:Cfg,row:Record<string,unknown>):boolean{
 const pathValue=row.path;if(typeof pathValue!=='string')return false;
 if(c.source_scope!=='all_cfo_source_documents')return c.source_prefixes.some(prefix=>pathValue.startsWith(prefix));
 if(!validPath(pathValue))return false;
 return !['_text','_catalog','_review','_memory','_state','_archive'].includes(pathValue.split('/')[0].toLowerCase());
}
async function catalog(d:GraphCatalogDeps,c:Cfg,s:AbortSignal){
 const pin=c.materialization;
 if(!pin){const read=await readPinnedGraphCatalog({key:c.catalog_key,sourceSha256:c.catalog_source_sha256,s3:d.catalogS3,signal:s});return{...read,rows:read.rows.filter(row=>sourceRowAllowed(c,row))};}
 await verifyMaterializationReceipt({cohort_id:c.cohort_id,policy_sha256:c.policy_sha256,source_prefixes:c.source_prefixes,source_scope:c.source_scope,catalog_key:c.catalog_key,catalog_source_sha256:c.catalog_source_sha256,materialization:pin},async request=>{
  return await bounded(()=>d.s3({method:'GET',key:request.key,signal:request.signal}),request.signal);
 },s);
 await sourceHead(d,pin.source_catalog_version_id,s);
 const read=await readPinnedGraphCatalog({key:c.catalog_key,sourceSha256:c.catalog_source_sha256,expectedContentSha256:pin.catalog_content_sha256,expectedVersionId:pin.catalog_version_id,s3:d.catalogS3??defaultGraphCatalogS3,signal:s});
 await sourceHead(d,pin.source_catalog_version_id,s);
 return {...read,rows:read.rows.filter(row=>sourceRowAllowed(c,row))};
}
function proposal(c:Cfg,cat:any,m:any){const item=m.documents[0],id=controllerId(c),key=hash(canonical({controller_id:id,document_version_id:item.document_version_id,source_version:item.source_version,enrichment_row_sha256:item.enrichment_row_sha256,extractor_version:item.extractor_version}));return{controller_id:id,key,catalog_snapshot_sha256:hash(canonical({source:c.catalog_source_sha256,etag:cat.catalogEtag,createdAt:cat.createdAt})),catalog_source_sha256:c.catalog_source_sha256,catalog_etag_sha256:hash(cat.catalogEtag),manifest:m,run:run(c,m.manifest_sha256),max_documents:1,document_ordinal:0,paid_fallback:false,requires_review:true};}
async function current(d:GraphCatalogDeps,c:Cfg,item:any,s:AbortSignal){const cat=await catalog(d,c,s);for(const row of cat.rows){if(hash(String(row.path))!==item.source_path_hash)continue;const p=planGraphCatalogPage({...cat,rows:[row],limit:1});if(p.page.manifest&&equal(p.page.manifest.documents[0],item))return true;}return false;}
async function serverProposal(d:GraphCatalogDeps,c:Cfg,key:string,s:AbortSignal){if(!SHA.test(key))fail(400,'graph_catalog_request_invalid');const p=await get(d,path(c,`server/proposals/${key}.json`),s);if(!p||p.value.key!==key||p.value.controller_id!==controllerId(c)||!validManifest(p.value.manifest)||!equal(p.value.run,run(c,p.value.manifest.manifest_sha256)))fail(409,'graph_catalog_proposal_missing');return p.value;}
function live(c:Cfg,d:GraphCatalogDeps){return c.max_admissions>0&&Date.parse(c.expires_at)>d.now();}
function recoveryLive(c:Cfg,d:GraphCatalogDeps){return !!c.recovery_policy_sha256&&!!c.recovery_expires_at&&Date.parse(c.recovery_expires_at)>d.now();}
async function receipt(d:GraphCatalogDeps,c:Cfg,runId:string,s:AbortSignal){if(!/^run_[a-f0-9]{64}$/.test(runId))fail(400,'graph_catalog_request_invalid');const saved=await get(d,path(c,`server/admissions/${runId}.json`),s);if(!saved)fail(403,'graph_catalog_admission_missing');const v=saved.value,{decision_sha256,...unsigned}=v;if(!exact(v,['allowed','key','run_id','manifest_sha256','max_documents','policy_sha256','decision_sha256'])||v.allowed!==true||v.max_documents!==1||v.policy_sha256!==c.policy_sha256||v.run_id!==runId||hash(canonical(unsigned))!==decision_sha256)fail();const p=await serverProposal(d,c,v.key,s);if(p.run.run_id!==runId||p.manifest.manifest_sha256!==v.manifest_sha256)fail();return{receipt:v,proposal:p};}
async function control(d:GraphCatalogDeps,c:Cfg,s:AbortSignal){const saved=await get(d,path(c,'server/control.json'),s);if(saved){const v=saved.value;if(!exact(v,['schema','policy_sha256','used','current'])||v.schema!=='graph-catalog-control-v1'||v.policy_sha256!==c.policy_sha256||!Number.isInteger(v.used)||v.used<1||v.used>1000||!exact(v.current,['status','key','run_id','manifest_sha256'])||!['reserved','active'].includes(v.current.status)||!SHA.test(v.current.key)||!SHA.test(v.current.manifest_sha256)||run(c,v.current.manifest_sha256).run_id!==v.current.run_id)fail();}return saved;}
async function preparation(d:GraphCatalogDeps,_c:Cfg,p:Json,value:Json,s:AbortSignal){
 const prep=value.preparation;if(!exact(prep,['snapshot_id','prepared_manifest_sha256','sidecar_content_sha256','chunk_count'])||!/^txtsnap_[a-f0-9]{64}$/.test(prep.snapshot_id)||!SHA.test(prep.prepared_manifest_sha256)||!SHA.test(prep.sidecar_content_sha256)||!Number.isInteger(prep.chunk_count)||prep.chunk_count<1||prep.chunk_count>100)return null;
 const saved=await get(d,`${WORKERS}/${p.run.run_id}/text-snapshots/${prep.snapshot_id}/manifest.json`,s);if(!saved)return null;const m=saved.value,{manifest_sha256,...content}=m;
 if(m.schema!=='cfo-text-prepared-manifest-v1'||manifest_sha256!==prep.prepared_manifest_sha256||manifest_sha256!==hash(canonical(content))||m.snapshot_id!==prep.snapshot_id||!m.identity||m.identity.run_id!==p.run.run_id||m.identity.document_ordinal!==0||`txtsnap_${hash(canonical(m.identity))}`!==m.snapshot_id||m.identity.descriptor?.source_document_version!==p.manifest.documents[0].document_version_id||m.identity.descriptor?.sidecar_content_sha256!==prep.sidecar_content_sha256||!Array.isArray(m.chunks)||m.chunks.length!==prep.chunk_count)return null;
 return m;
}
async function boundOperation(d:GraphCatalogDeps,c:Cfg,p:Json,value:Json,ordinal:number,s:AbortSignal){
 const m=await preparation(d,c,p,value,s),chunk=value.chunks?.[ordinal];if(!m||!chunk||chunk.chunk_ordinal!==ordinal||!/^subop_[a-f0-9]{64}$/.test(chunk.operation_id))return null;
 const raw=await get(d,`${WORKERS}/${p.run.run_id}/subscription-jobs/operations/${chunk.operation_id}.json`,s);if(!raw)return null;const env=raw.value,o=env.operation,spec=o?.spec,b=spec?.source_binding,ref=m.chunks[ordinal];
 if(env.schema!=='subscription-model-operation-v1'||env.operation_id!==chunk.operation_id||env.operation_sha256!==hash(canonical(o))||o.operation_id!==chunk.operation_id||chunk.operation_id!==`subop_${hash(canonical(spec))}`||spec.purpose!==p.run.purpose||!b||b.schema!=='cfo-prepared-chunk-binding-v1'||b.run_id!==p.run.run_id||b.room!=='finance'||b.source_index!=='finance-cfo-source-docs'||b.catalog_manifest_sha256!==p.manifest.manifest_sha256||b.document_ordinal!==0||b.source_document_version!==p.manifest.documents[0].document_version_id||b.catalog_source_sha256!==p.manifest.documents[0].source_version||b.snapshot_id!==m.snapshot_id||b.prepared_manifest_sha256!==m.manifest_sha256||b.sidecar_content_sha256!==value.preparation.sidecar_content_sha256||b.chunk_ordinal!==ordinal||ref.ordinal!==ordinal||b.chunk_sha256!==ref.text_sha256)return null;
 return{raw,spec,chunk,binding:b};
}
async function resultFor(d:GraphCatalogDeps,p:Json,op:NonNullable<Awaited<ReturnType<typeof boundOperation>>>,s:AbortSignal){const saved=await get(d,`${WORKERS}/${p.run.run_id}/subscription-jobs/results/${op.chunk.operation_id}.json`,s);if(!saved)return null;const env=saved.value,r=env.result,out=r?.output;
 if(env.schema!=='subscription-model-result-v1'||env.operation_id!==op.chunk.operation_id||env.result_sha256!==hash(canonical(r))||r.operation_id!==op.chunk.operation_id||r.spec_sha256!==hash(canonical(op.spec))||out?.provider!==op.spec.provider||out?.model!==op.spec.model||out.billing_route!=='chatgpt_subscription'||out.paid_fallback!==false||out.source_sha256!==op.binding.chunk_sha256||!Array.isArray(out.candidates))return null;return saved;
}
async function completed(d:GraphCatalogDeps,c:Cfg,p:Json,value:Json,s:AbortSignal){if(!value.preparation||!Array.isArray(value.chunks)||value.chunks.length!==value.preparation.chunk_count||!value.chunks.length)return false;for(let n=0;n<value.chunks.length;n++){const op=await boundOperation(d,c,p,value,n,s);if(!op||!await resultFor(d,p,op,s))return false;}return true;}
async function validateState(d:GraphCatalogDeps,c:Cfg,key:string,value:Json,prior:Json|null,s:AbortSignal){
 if(key==='cursor'){
  if(!exact(value,['schema','controller_id','snapshot','cursor','done','pending'])||value.schema!=='catalog-controller-cursor-v1'||value.controller_id!==controllerId(c)||typeof value.done!=='boolean'||!(value.snapshot===null||SHA.test(value.snapshot))||!Array.isArray(value.pending)||value.pending.length>10||new Set(value.pending).size!==value.pending.length||value.pending.some((v:any)=>!SHA.test(v)))fail(400,'graph_catalog_state_invalid');
  if(value.cursor!==null&&(!exact(value.cursor,['room','catalog_source_sha256','catalog_etag_sha256','after_document_id'])||value.cursor.room!=='finance'||value.cursor.catalog_source_sha256!==c.catalog_source_sha256||!SHA.test(value.cursor.catalog_etag_sha256)||!/^docv_[a-f0-9]{64}$/.test(value.cursor.after_document_id)))fail(400,'graph_catalog_state_invalid');
  for(const pending of value.pending)await serverProposal(d,c,pending,s);return;
 }
 const p=await serverProposal(d,c,key.slice(9),s);
 if(!exact(value,['schema','proposal','status','outcome','chunks','preparation'])||value.schema!=='catalog-controller-version-v1'||!equal(value.proposal,p)||!['prepared','dispatching','held','complete','deferred'].includes(value.status)||!Array.isArray(value.chunks)||value.chunks.length>100)fail(400,'graph_catalog_state_invalid');
 if(!prior&&(value.status!=='prepared'||value.outcome!==null||value.preparation!==null||value.chunks.length))fail(409,'graph_catalog_state_transition');
 if(prior){if(!equal(prior.proposal,value.proposal))fail(409,'graph_catalog_state_transition');const transitions:Record<string,string[]>={prepared:['prepared','dispatching','deferred'],dispatching:['dispatching','held','complete','deferred'],held:['held','complete','deferred'],complete:[],deferred:[]};if(!equal(prior,value)&&!transitions[prior.status]?.includes(value.status))fail(409,'graph_catalog_state_transition');if(prior.preparation&&!equal(prior.preparation,value.preparation))fail(409,'graph_catalog_state_transition');if(value.chunks.length<prior.chunks.length)fail(409,'graph_catalog_state_transition');for(let n=0;n<prior.chunks.length;n++)if(prior.chunks[n].operation_id!==value.chunks[n].operation_id)fail(409,'graph_catalog_state_transition');}
 for(let n=0;n<value.chunks.length;n++){const chunk=value.chunks[n];if(!exact(chunk,['chunk_ordinal','operation_id','status','receipt_sha256'])||chunk.chunk_ordinal!==n||!/^subop_[a-f0-9]{64}$/.test(chunk.operation_id)||!SHA.test(chunk.receipt_sha256)||!['complete','paused','unknown','denied','cancelled'].includes(chunk.status))fail(400,'graph_catalog_state_invalid');}
 if(value.outcome!==null){const o=value.outcome,fields=['status','code','receipt_sha256','run_id','document_ordinal','recorded_at','chunk_receipts_sha256',...(value.status==='complete'?['completed_chunks']:[]),...(o?.reconciliation_evidence_sha256===undefined?[]:['reconciliation_evidence_sha256'])];
  const codes:Record<string,string[]>={complete:['document_canary_complete'],deferred:['missing_text','oversize','invalid_utf8','source_changed','preparation_oversize','review_declined'],held:['subscription_limit_pause','subscription_login_required','dispatch_outcome_unknown','source_not_authorized']};
  if(!exact(o,fields)||o.status!==value.status||!codes[value.status]?.includes(o.code)||!SHA.test(o.receipt_sha256)||o.run_id!==p.run.run_id||o.document_ordinal!==0||o.chunk_receipts_sha256!==hash(canonical(value.chunks))||typeof o.recorded_at!=='string'||!Number.isFinite(Date.parse(o.recorded_at))||(o.reconciliation_evidence_sha256!==undefined&&!SHA.test(o.reconciliation_evidence_sha256))||(value.status==='complete'&&o.completed_chunks!==value.chunks.length))fail(400,'graph_catalog_state_invalid');
 }else if(['complete','deferred','held'].includes(value.status))fail(400,'graph_catalog_state_invalid');
 if(value.preparation&&!await preparation(d,c,p,value,s))fail(409,'graph_catalog_preparation_unconfirmed');
 if(value.status==='complete'&&(value.chunks.some((x:any)=>x.status!=='complete')||!await completed(d,c,p,value,s)))fail(409,'graph_catalog_completion_unconfirmed');
}
export async function resolveCatalogCohortBinding(ctx:AuthContext,runId:string,signal:AbortSignal,i?:Partial<GraphCatalogDeps>):Promise<{policy:{schema:'graph-worker-bindings-v1';policy_version:string;expires_at:string;bindings:Binding[]};binding:Binding}|null>{
 if(ctx.caller_agent!=='cfo'||!ctx.connector_surface)return null;const d=depsOf(i);let all;try{all=JSON.parse(d.configs());}catch{return null;}if(!Array.isArray(all)||all.length>32)return null;
 for(const raw of all){const c=configFor(d.configs(),raw?.cohort_id);if(!c||!live(c,d))continue;const ctl=await control(d,c,signal);if(ctl?.value.current.status!=='active'||ctl.value.current.run_id!==runId)continue;const a=await receipt(d,c,runId,signal);if(a.receipt.key!==ctl.value.current.key||a.receipt.manifest_sha256!==ctl.value.current.manifest_sha256)fail();const binding:Binding={authenticated_caller:'cfo',run:a.proposal.run,room:'finance',source_index:'finance-cfo-source-docs'};return{binding,policy:{schema:'graph-worker-bindings-v1',policy_version:c.policy_sha256,expires_at:c.expires_at,bindings:[binding]}};}return null;
}
export function registerGraphCatalogControllerRoutes(app:FastifyInstance,i?:Partial<GraphCatalogDeps>):void{
 const d=depsOf(i),prefix='/graph-catalog/v1/:cohortId';
 const route=(method:'GET'|'POST'|'PUT',suffix:string,fn:(r:FastifyRequest,p:FastifyReply,c:Cfg,s:AbortSignal)=>Promise<any>,recovery=false)=>{
 app.route({method,url:prefix+suffix,bodyLimit:256*1024,handler:async(r,p)=>{const internal=new AbortController(),timer=setTimeout(()=>internal.abort(),45000);const cancel=()=>internal.abort();r.raw.on('aborted',cancel);const disconnected=()=>{if(!p.raw.writableFinished)cancel();};p.raw.on('close',disconnected);
 try{if(r.url.includes('?')||typeof r.headers.authorization!=='string')fail(403,'graph_catalog_forbidden');const ctx=await bounded(()=>d.authenticate(r,p),internal.signal);if(p.sent)return;if(!ctx?.connector_surface||ctx.caller_agent!=='cfo')fail(403,'graph_catalog_forbidden');const c=configFor(d.configs(),(r.params as Json).cohortId);if(!c)fail(404,'graph_catalog_disabled');if(recovery?!recoveryLive(c,d):suffix==='/state/*'?!live(c,d)&&!recoveryLive(c,d):suffix!=='/config'&&!live(c,d))fail(403,'graph_catalog_disabled');return await fn(r,p,c,internal.signal);}
 catch(e:any){if(!p.sent)return p.code(Number.isInteger(e?.status)?e.status:503).send({error:typeof e?.code==='string'&&e.code.startsWith('graph_catalog_')?e.code:'graph_catalog_unavailable'});}
 finally{clearTimeout(timer);internal.abort();r.raw.off('aborted',cancel);p.raw.off('close',disconnected);}}});};
 route('GET','/config',async(_r,_p,c)=>({enabled:live(c,d),cohort_id:c.cohort_id,controller:{catalogSourceSha256:c.catalog_source_sha256,purpose:c.purpose,runVersion:c.run_version,batchSize:c.batch_size},policy_sha256:c.policy_sha256,max_admissions:c.max_admissions}));
 route('POST','/page',async(r,_p,c,s)=>{const b=r.body as Json;if(!exact(b,['cursor','limit'])||!Number.isInteger(b.limit)||b.limit<1||b.limit>c.batch_size)fail(400,'graph_catalog_request_invalid');return planGraphCatalogPage({...await catalog(d,c,s),cursor:b.cursor,limit:b.limit});});
 route('POST','/source-current',async(r,_p,c,s)=>{const b=r.body as Json;if(!exact(b,['item'])||!validItem(b.item))fail(400,'graph_catalog_request_invalid');return{current:await current(d,c,b.item,s)};});
 route('POST','/publish',async(r,_p,c,s)=>{const b=r.body as Json;if(!exact(b,['manifest','rows'])||!validManifest(b.manifest)||!Array.isArray(b.rows)||b.rows.length!==1)fail(400,'graph_catalog_request_invalid');const cat=await catalog(d,c,s),item=b.manifest.documents[0];let found=false;
 for(const row of cat.rows){if(hash(String(row.path))!==item.source_path_hash)continue;const planned=planGraphCatalogPage({...cat,rows:[row],limit:1});if(equal(planned.page.manifest,b.manifest)&&equal(planned.page.rows,b.rows)){found=true;break;}}if(!found)fail(409,'graph_catalog_source_changed');
 const p=proposal(c,cat,b.manifest);await immutable(d,`${SOURCE}/rows/finance/${item.enrichment_row_sha256}.json`,{schema:'catalog-mention-snapshot-v1',room:'finance',document_version_id:item.document_version_id,row:b.rows[0]},s);await immutable(d,`${SOURCE}/manifests/${b.manifest.manifest_sha256}.json`,b.manifest,s);await immutable(d,path(c,`server/proposals/${p.key}.json`),p,s);await immutable(d,path(c,`server/manifests/${b.manifest.manifest_sha256}.json`),{key:p.key,manifest:b.manifest},s);return{confirmed:true,manifest_sha256:b.manifest.manifest_sha256,documents:1};});
 route('GET','/manifests/:sha',async(r,_p,c,s)=>{const sha=(r.params as Json).sha;if(!SHA.test(sha))fail(400,'graph_catalog_request_invalid');const saved=await get(d,path(c,`server/manifests/${sha}.json`),s);if(!saved||!validManifest(saved.value.manifest)||saved.value.manifest.manifest_sha256!==sha)fail(404,'graph_catalog_manifest_missing');return saved.value.manifest;});
 route('GET','/state/*',async(r,p,c,s)=>{const key=(r.params as Json)['*'];if(!/^(cursor|versions\/[a-f0-9]{64})$/.test(key))fail(400,'graph_catalog_request_invalid');const v=await get(d,path(c,`controller/${key}.json`),s);if(!v)return p.code(404).send({error:'graph_catalog_state_missing'});return{revision:v.etag,value:v.value};});
 route('PUT','/state/*',async(r,p,c,s)=>{const key=(r.params as Json)['*'],b=r.body as Json;if(!/^(cursor|versions\/[a-f0-9]{64})$/.test(key)||!exact(b,['key','revision','value'])||b.key!==key||!(b.revision===null||ETAG.test(b.revision)))fail(400,'graph_catalog_request_invalid');const old=await get(d,path(c,`controller/${key}.json`),s);if((old?.etag??null)!==b.revision)return p.code(409).send({committed:false});if(!live(c,d)){if(key==='cursor'||!old||!['dispatching','held'].includes(old.value.status)||b.value?.status!=='complete'||!equal(old.value.proposal,b.value.proposal))fail(403,'graph_catalog_recovery_forbidden');await receipt(d,c,old.value.proposal.run.run_id,s);}await validateState(d,c,key,b.value,old?.value??null,s);if(!await cas(d,path(c,`controller/${key}.json`),old,b.value,s))return p.code(409).send({committed:false});const saved=await get(d,path(c,`controller/${key}.json`),s);if(!saved||!equal(saved.value,b.value))fail();return{committed:true,revision:saved.etag};});
 route('POST','/admit',async(r,_p,c,s)=>{const b=r.body as Json;if(!exact(b,['key','manifest_sha256'])||!SHA.test(b.key)||!SHA.test(b.manifest_sha256))fail(400,'graph_catalog_request_invalid');const p=await serverProposal(d,c,b.key,s);if(p.manifest.manifest_sha256!==b.manifest_sha256)fail(409,'graph_catalog_proposal_missing');let ctl=await control(d,c,s);const same=ctl?.value.current.key===b.key;
 if(same&&ctl!.value.current.status==='active'){if(!await current(d,c,p.manifest.documents[0],s))fail(409,'graph_catalog_source_changed');return(await receipt(d,c,p.run.run_id,s)).receipt;}
 if(!same){if(!await current(d,c,p.manifest.documents[0],s))fail(409,'graph_catalog_source_changed');if(ctl){const prior=await receipt(d,c,ctl.value.current.run_id,s),progress=await get(d,path(c,`controller/versions/${prior.proposal.key}.json`),s);if(!progress||!await completed(d,c,prior.proposal,progress.value,s))fail(409,'graph_catalog_prior_run_held');}
 if((ctl?.value.used??0)>=c.max_admissions)fail(409,'graph_catalog_budget_exhausted');const reserved={schema:'graph-catalog-control-v1',policy_sha256:c.policy_sha256,used:(ctl?.value.used??0)+1,current:{status:'reserved',key:b.key,run_id:p.run.run_id,manifest_sha256:b.manifest_sha256}};if(!await cas(d,path(c,'server/control.json'),ctl,reserved,s))fail(409,'graph_catalog_admission_conflict');ctl=await control(d,c,s);}
 if(!ctl||ctl.value.current.key!==b.key||ctl.value.current.status!=='reserved')fail();if(!live(c,d))fail(403,'graph_catalog_disabled');
 const state={status:'active',run:p.run,superseded_run:null,tombstone:null};await immutable(d,`${WORKERS}/${p.run.run_id}/active-runs/${hash(canonical({purpose:c.purpose,scope:'finance'}))}.json`,{schema:'neptune-trial-active-run-state-v1',state_sha256:hash(canonical(state)),state},s);
 const unsigned={allowed:true,key:b.key,run_id:p.run.run_id,manifest_sha256:b.manifest_sha256,max_documents:1,policy_sha256:c.policy_sha256},issued={...unsigned,decision_sha256:hash(canonical(unsigned))};await immutable(d,path(c,`server/admissions/${p.run.run_id}.json`),issued,s);
 if(!live(c,d)||!await cas(d,path(c,'server/control.json'),ctl,{...ctl.value,current:{...ctl.value.current,status:'active'}},s))fail(409,'graph_catalog_admission_conflict');return issued;
 });
 route('POST','/review',async(r,_p,c,s)=>{const b=r.body as Json;if(!exact(b,['key','run_id','manifest_sha256']))fail(400,'graph_catalog_request_invalid');const a=await receipt(d,c,b.run_id,s),ctl=await control(d,c,s);if(a.receipt.key!==b.key||a.receipt.manifest_sha256!==b.manifest_sha256||ctl?.value.current.run_id!==b.run_id||ctl?.value.current.status!=='active')fail(403,'graph_catalog_review_forbidden');return a.receipt;});
 route('POST','/recovery',async(r,_p,c,s)=>{const b=r.body as Json;if(!exact(b,['key','run_id']))fail(400,'graph_catalog_request_invalid');const a=await receipt(d,c,b.run_id,s);if(a.receipt.key!==b.key)fail(403,'graph_catalog_recovery_forbidden');const v={allowed:true,key:b.key,run_id:b.run_id,policy_sha256:c.recovery_policy_sha256};return{...v,decision_sha256:hash(canonical(v))};},true);
 route('GET','/recovery-state/:runId/:artifact/:operationId.json',async(r,p,c,s)=>{const q=r.params as Json;if(!['operations','results'].includes(q.artifact)||!/^subop_[a-f0-9]{64}$/.test(q.operationId))fail(400,'graph_catalog_request_invalid');const a=await receipt(d,c,q.runId,s),progress=await get(d,path(c,`controller/versions/${a.proposal.key}.json`),s),n=progress?.value.chunks?.findIndex((v:any)=>v.operation_id===q.operationId);if(!progress||!Number.isInteger(n)||n<0)fail(403,'graph_catalog_recovery_forbidden');const op=await boundOperation(d,c,a.proposal,progress.value,n,s);if(!op)fail(403,'graph_catalog_recovery_forbidden');const saved=q.artifact==='operations'?op.raw:await resultFor(d,a.proposal,op,s);if(!saved)return p.code(404).send({error:'graph_catalog_result_missing'});p.header('etag',saved.etag).type('application/json');return p.send(saved.raw.body);},true);
}
export const graphCatalogControllerTest={canonical,hash,configFor,validManifest,validItem,BASE,controllerId,proposal};




/** Resolve only already-issued server records. This never admits or reopens a run. */
export async function resolveRelationshipPublicationAdmission(input:{cohortId:string;run:{run_id:string};ctx:AuthContext;signal:AbortSignal},injected?:Partial<GraphCatalogDeps>){
 const {cohortId,run,ctx,signal}=input;
 if(ctx.caller_agent!=='cfo'||!ctx.connector_surface||!SHA.test(ctx.caller_hash)||!ID.test(cohortId)||!validPath(cohortId)||!/^run_[a-f0-9]{64}$/.test(run.run_id))fail(403);
 const d=depsOf(injected),admissionKey=`${BASE}/${cohortId}/server/admissions/${run.run_id}.json`;
 const admission=await get(d,admissionKey,signal);if(!admission||!SHA.test(admission.value.key))fail(403);
 const proposalKey=`${BASE}/${cohortId}/server/proposals/${admission.value.key}.json`,proposal=await get(d,proposalKey,signal);if(!proposal)fail(403);
 const pin=(key:string,r:NonNullable<typeof admission>)=>{const version_id=r.raw.headers.get('x-amz-version-id');if(!version_id||version_id==='null'||version_id.length>1024||/[\s\p{C}]/u.test(version_id))fail();return{key,version_id,sha256:hash(r.raw.body)};};
 return{admission:pin(admissionKey,admission),proposal:pin(proposalKey,proposal)};
}
