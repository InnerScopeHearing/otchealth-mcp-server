import assert from 'node:assert/strict';
import test from 'node:test';
import {planGraphCatalogPage} from './graph-catalog-planner.js';
import {createCfoTextSnapshotReader} from '../graph/cfo-text-snapshot.js';
import Fastify from 'fastify';
import '../../tools/relationship-artifacts/historical-reader.test.mjs';
import '../../tools/relationship-artifacts/cross-run-recall.test.mjs';
import '../../tools/relationship-artifacts/recall-journal.test.mjs';

for (const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'})) process.env[key]??=value;

const {relationshipHistoricalReadTest:h,registerRelationshipHistoricalReadRoutes}=await import('./relationship-historical-read.js');
const {canonical,hash,parse,validRun,admissionChain,sourceBound,sourcePathAllowed,defaultSource}=h;
const now=Date.parse('2026-09-08T12:00:00.000Z'), sha=(s:string)=>hash(s);
function policy(sourcePolicy?:any){
 const content={ref_version:'neptune-trial-active-run-ref-v1',purpose:'company_graph_backfill',scope:'finance',run_version:'synthetic-v1',manifest_sha256:sha('manifest')};
 const run={...content,run_id:'run_'+hash(canonical(content))}, cohort='synthetic-cohort', proposalKey=sha('proposal'), caller=sha('caller');
 return {schema:'relationship-history-policy-v1',policy_version:'synthetic-v1',expires_at:new Date(now+60000).toISOString(),bindings:[{authenticated_caller:'cfo',caller_hash:caller,producer_id:'synthetic-producer',run,encryption:{algorithm:'AES256'},cohort_id:cohort,admission:{key:`graph-trial/20260908/catalog-cohorts/${cohort}/server/admissions/${run.run_id}.json`,version_id:'v1',sha256:sha('admission')},proposal:{key:`graph-trial/20260908/catalog-cohorts/${cohort}/server/proposals/${proposalKey}.json`,version_id:'v2',sha256:sha('proposal-body')},approved_artifacts:[{digest:sha('artifact'),version_id:'v3'}],source_policy:sourcePolicy??{catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:sha('catalog'),source_prefixes:['finance/']}}]};
}
test('historical policy parser rejects duplicate authority, traversal, null versions, and oversized allowlists',()=>{
 const valid=policy(); assert.ok(validRun(valid.bindings[0].run)); assert.ok(parse(canonical(valid),now));
 const cases:any[]=[];
 cases.push({...valid,bindings:[...valid.bindings,...valid.bindings]});
 cases.push({...valid,bindings:[{...valid.bindings[0],proposal:{...valid.bindings[0].proposal,key:'graph-trial/20260908/catalog-cohorts/synthetic-cohort/server/proposals/../'+sha('proposal')+'.json'}}]});
 cases.push({...valid,bindings:[{...valid.bindings[0],admission:{...valid.bindings[0].admission,version_id:'null'}}]});
 cases.push({...valid,bindings:[{...valid.bindings[0],approved_artifacts:[...valid.bindings[0].approved_artifacts,...valid.bindings[0].approved_artifacts]}]});
 cases.push({...valid,bindings:[{...valid.bindings[0],source_policy:{...valid.bindings[0].source_policy,source_prefixes:['finance/','finance/']}}]});
 for(const value of cases) assert.equal(parse(canonical(value),now),null);
});
test('historical policy accepts explicit all-CFO scope only with empty prefixes',()=>{
 const base={catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:sha('catalog')};
 assert.ok(parse(canonical(policy({...base,source_prefixes:[],source_scope:'all_cfo_source_documents'})),now));
 assert.equal(parse(canonical(policy({...base,source_prefixes:[]})),now),null);
 assert.equal(parse(canonical(policy({...base,source_prefixes:['finance/'],source_scope:'all_cfo_source_documents'})),now),null);
 assert.equal(parse(canonical(policy({...base,source_prefixes:[],source_scope:'all_company_documents'})),now),null);
});
function evidence({rowPath='finance/synthetic.pdf',sourcePolicy}:any={}){
 const b:any=policy(sourcePolicy).bindings[0],row={path:rowPath,sha256:sha('binary'),enriched_sha256:sha('binary'),sidecar:true,enriched:true,err:null};
 const manifest=planGraphCatalogPage({rows:[row],catalogEtag:'synthetic',catalogSourceSha256:b.source_policy.catalog_source_sha256,createdAt:'2026-09-08T12:00:00.000Z'}).page.manifest!;
 const runBody={ref_version:b.run.ref_version,purpose:b.run.purpose,scope:'finance',run_version:b.run.run_version,manifest_sha256:manifest.manifest_sha256};b.run={...runBody,run_id:'run_'+hash(canonical(runBody))};
 const controller=hash(canonical({schema:'catalog-controller-v1',room:'finance',catalogSourceSha256:b.source_policy.catalog_source_sha256,purpose:b.run.purpose,runVersion:b.run.run_version})),item=manifest.documents[0];
 const key=hash(canonical({controller_id:controller,document_version_id:item.document_version_id,source_version:item.source_version,enrichment_row_sha256:item.enrichment_row_sha256,extractor_version:item.extractor_version}));
 b.proposal.key=`graph-trial/20260908/catalog-cohorts/${b.cohort_id}/server/proposals/${key}.json`;
 const proposal={controller_id:controller,key,catalog_snapshot_sha256:sha('snapshot'),catalog_source_sha256:b.source_policy.catalog_source_sha256,catalog_etag_sha256:sha('etag'),manifest,run:b.run,max_documents:1,document_ordinal:0,paid_fallback:false,requires_review:true};
 const bare={allowed:true,key,run_id:b.run.run_id,manifest_sha256:manifest.manifest_sha256,max_documents:1,policy_sha256:sha('policy')},admission={...bare,decision_sha256:hash(canonical(bare))};
 const source={payload:{input:{binding:{schema:'cfo-prepared-chunk-binding-v1',run_id:b.run.run_id,room:'finance',source_index:'finance-cfo-source-docs',catalog_manifest_sha256:b.run.manifest_sha256,document_ordinal:0,source_document_version:item.document_version_id,catalog_source_sha256:item.source_version,snapshot_id:'txtsnap_'+sha('snapshot'),prepared_manifest_sha256:sha('prepared'),sidecar_content_sha256:sha('text'),chunk_ordinal:0,chunk_sha256:sha('text')},catalog_row:row,prepared_text:'text',chunk_start_utf16:0,chunk_end_utf16:4,purpose:b.run.purpose}}};return{b,proposal,admission,source};
}
test('valid pinned admission chain refuses cross-run and proposal substitutions',()=>{
 const {b,proposal,admission}=evidence();assert.equal(admissionChain(admission,proposal,b),true);
 for(const mutate of[(a:any)=>a.run_id='run_'+sha('other'),(a:any)=>a.key=sha('other'),(a:any)=>a.manifest_sha256=sha('other')]){const a=structuredClone(admission);mutate(a);assert.equal(admissionChain(a,proposal,b),false);}
 assert.equal(admissionChain(admission,{...proposal,controller_id:sha('other')},b),false);
});
test('valid prepared source refuses run, manifest, chunk and text substitutions',()=>{
 const {b,proposal,source}=evidence();assert.equal(sourceBound(source,b,proposal),true);
 for(const mutate of[(s:any)=>s.payload.input.binding.run_id='run_'+sha('other'),(s:any)=>s.payload.input.binding.catalog_manifest_sha256=sha('other'),(s:any)=>s.payload.input.binding.chunk_sha256=sha('other'),(s:any)=>s.payload.input.prepared_text='other', (s:any)=>s.payload.input.catalog_row.path='legal/other.pdf']){const s=structuredClone(source);mutate(s);assert.equal(sourceBound(s,b,proposal),false);}
});
test('root-level CFO source is allowed only by explicit all-source scope',()=>{
 const base={catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:sha('catalog')};
 const all=evidence({rowPath:'root-document.pdf',sourcePolicy:{...base,source_prefixes:[],source_scope:'all_cfo_source_documents'}});
 assert.equal(sourceBound(all.source,all.b,all.proposal),true);
 assert.equal(sourcePathAllowed({...base,source_prefixes:[],source_scope:'all_cfo_source_documents'},'_catalog/internal.json'),false);
 assert.equal(sourcePathAllowed({...base,source_prefixes:['finance/']},'legal/other.pdf'),false);
 const scoped=evidence({rowPath:'root-document.pdf',sourcePolicy:{...base,source_prefixes:['finance/']}});
 assert.equal(sourceBound(scoped.source,scoped.b,scoped.proposal),false);
 const foreign=structuredClone(all.source);foreign.payload.input.binding.room='legal_company';
 assert.equal(sourceBound(foreign,all.b,all.proposal),false);
});
test('default source currentness uses the frozen descriptor required by the real CFO snapshot reader',async()=>{
 const text='Synthetic current CFO source.';const row={path:'finance/synthetic.txt'};
 const binding={source_document_version:'docv_'+sha('source'),catalog_source_sha256:sha('catalog'),sidecar_content_sha256:sha(text)};
 const reader=createCfoTextSnapshotReader({callerContext:{caller_agent:'cfo',connector_surface:true},maxSourceBytes:1024*1024,credentialProvider:async()=>({accessKeyId:'synthetic',secretAccessKey:'synthetic'}),signer:input=>({headers:input.extraHeaders??{}}),fetchImpl:async(_url,init)=>init.method==='HEAD'?new Response('',{status:200,headers:{etag:'"synthetic"','x-amz-version-id':'synthetic-v1','content-length':String(Buffer.byteLength(text))}}):new Response(text,{status:200,headers:{etag:'"synthetic"','x-amz-version-id':'synthetic-v1','content-length':String(Buffer.byteLength(text))}})});
 const current=await defaultSource(row,binding,{caller_agent:'cfo',caller_hash:sha('caller'),connector_surface:true,raw_token:'synthetic',m365_static_auth:false},new AbortController().signal,reader);
 assert.equal(current,true);
});
test('historical GET verifies pinned records and fresh source policy without execution authority',async()=>{
 const {b,proposal,admission,source}=evidence(),objects=new Map<string,any>();
 b.admission.key=`graph-trial/20260908/catalog-cohorts/${b.cohort_id}/server/admissions/${b.run.run_id}.json`;
 for(const [ref,value] of[[b.admission,admission],[b.proposal,proposal]]){const body=Buffer.from(canonical(value));ref.sha256=hash(body);objects.set(ref.key,{status:200,body,headers:new Headers({'x-amz-version-id':ref.version_id})});}
 const payload={schema:'resolution-source-input-v1',run:b.run,input:source.payload.input},digest=hash(canonical(payload)),version='synthetic+/=version';
 b.approved_artifacts=[{digest,version_id:version}];const key=h.artifactKey(b.run.run_id,b.producer_id,digest);
 objects.set(key,{status:200,body:Buffer.from(canonical({schema:'relationship-resolution-artifact-v1',payload_sha256:digest,payload})),headers:new Headers({'x-amz-version-id':version,'x-amz-meta-resolution-run':b.run.run_id,'x-amz-meta-resolution-producer':b.producer_id,'x-amz-server-side-encryption':'AES256'})});
 let value:any={...policy(),bindings:[b]},rows:any[]=[source.payload.input.catalog_row],checks=0,revoke=false;
 const app=Fastify();registerRelationshipHistoricalReadRoutes(app,{now:()=>now,policyJson:()=>canonical(value),authenticate:async()=>({caller_agent:'cfo',caller_hash:b.caller_hash,connector_surface:true,raw_token:'synthetic',m365_static_auth:false}),readVersion:async r=>{assert.ok(r.versionId);assert.ok(!r.key.includes('/active-runs/'));return objects.get(r.key);},readCatalog:async()=>rows,checkSource:async()=>{checks++;if(revoke&&checks%2===0)value=null;return true;}});
 const url=`/relationship-history/v1/${b.run.run_id}/${b.producer_id}/sha256/${digest.slice(0,2)}/${digest}.json?versionId=${encodeURIComponent(version)}`;
 try{
  const ok=await app.inject({url});assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.headers['x-relationship-source-current'],'true');assert.equal(checks,2);
  assert.equal((await app.inject({url:url.split('?')[0]})).statusCode,400);
  for(const method of['PUT','POST','DELETE'] as const)assert.equal((await app.inject({url,method})).statusCode,404);
  rows=[{...source.payload.input.catalog_row,sha256:sha('changed')}];const changed=await app.inject({url});assert.equal(changed.statusCode,200);assert.equal(changed.headers['x-relationship-source-current'],'false');
  rows=[];assert.equal((await app.inject({url})).statusCode,403);
  rows=[source.payload.input.catalog_row];revoke=true;assert.equal((await app.inject({url})).statusCode,403);
 }finally{await app.close();}
});
