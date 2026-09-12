import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createCandidatePromotionRuntime, runCandidatePromotionRuntimeCli} from './candidate-promotion-runtime.mjs';
const hash='a'.repeat(64), run={ref_version:'neptune-trial-active-run-ref-v1',run_id:'run_'+'b'.repeat(64),purpose:'synthetic',scope:'finance',run_version:'v1',manifest_sha256:'c'.repeat(64)};
const ref={schema:'relationship-resolution-artifact-ref-v1',artifact_id:'resart_'+hash,bucket:'synthetic',key:'synthetic/ref.json',payload_sha256:hash,version_id:'v1',size_bytes:1};
const config={schema:'candidate-promotion-runtime-v2',backfill_config:'C:\\synthetic\\backfill.json',parent_artifact_ref:ref,parent_run:run,target:{source_document_version:'docv_'+'d'.repeat(64),catalog_source_sha256:'e'.repeat(64)}};
test('runtime CLI invokes the composed no-extraction runner and emits only bounded receipt metadata',async()=>{let received,output=[];const code=await runCandidatePromotionRuntimeCli({argv:['--config','synthetic.json'],load:async()=>config,create:async input=>{received=input;return{run:async()=>({run:{...run,run_id:'run_'+'f'.repeat(64)},publication:{code:'relationship_published'}})};},stdout:{write:x=>output.push(x)},stderr:{write:()=>{}}});assert.equal(code,0);assert.deepEqual(received.config.target,config.target);const receipt=JSON.parse(output[0]);assert.deepEqual(receipt,{schema:'candidate-promotion-runtime-receipt-v1',status:'complete',run_id:'run_'+'f'.repeat(64),publication:'relationship_published'});assert.equal(JSON.stringify(receipt).includes('source_document_version'),false);});
test('runtime CLI rejects malformed immutable target before composing',async()=>{let called=false,stderr=[];const code=await runCandidatePromotionRuntimeCli({argv:['--config','synthetic.json'],load:async()=>({...config,target:{...config.target,catalog_source_sha256:'bad'}}),create:async()=>{called=true;},stdout:{write:()=>{}},stderr:{write:x=>stderr.push(x)}});assert.equal(code,2);assert.equal(called,false);assert.deepEqual(JSON.parse(stderr[0]),{schema:'candidate-promotion-runtime-receipt-v1',status:'not_ready',reason:'candidate_promotion_runtime_config'});});

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
const activeRun=(purpose,run_version,manifest_sha256)=>{const body={ref_version:'neptune-trial-active-run-ref-v1',purpose,scope:'finance',run_version,manifest_sha256};return{...body,run_id:'run_'+sha(body)}};
const artifact=digest=>({schema:'relationship-resolution-artifact-ref-v1',artifact_id:'resart_'+digest,bucket:'otchealth-finance-legal-dr-55c84f6b',key:`resolution-artifacts/sha256/${digest.slice(0,2)}/${digest}.json`,payload_sha256:digest,version_id:'synthetic-v1',size_bytes:1});
test('production runtime composes historical parent, durable lineage, outbox publication and completion without an extractor',async()=>{const root=await mkdtemp(join(tmpdir(),'candidate-promotion-'));try{const parentRun=activeRun('relationship-candidates','parent-v1','a'.repeat(64)),targetRun=activeRun('relationship-candidates','promotion-v1','b'.repeat(64)),parentRef=artifact('c'.repeat(64)),publishedRef=artifact('d'.repeat(64)),target={source_document_version:'docv_'+'e'.repeat(64),catalog_source_sha256:'f'.repeat(64)},source={...target,chunk_sha256:'1'.repeat(64)},proposal={key:'2'.repeat(64),status:'prepared',run:targetRun,manifest:{manifest_sha256:targetRun.manifest_sha256,documents:[{document_version_id:target.source_document_version,source_version:target.catalog_source_sha256}]}};
 const backfill={registry:{id:'registry-synthetic'},review_mode:'subscription',cto_root:root,producer:'cfo-relationship-worker',outbox_directory:join(root,'outbox'),extractor_model:'gpt-5.6-luna'},backfillPath=join(root,'backfill.json'),local={schema:'candidate-promotion-runtime-v2',backfill_config:backfillPath,parent_artifact_ref:parentRef,parent_run:parentRun,target};await writeFile(backfillPath,JSON.stringify(backfill));let reviewCalls=0,publishCalls=0,completion,extractorCalls=0;
 const runtimePort={
  host:{cohort_id:'synthetic',binary:'C:/synthetic/codex.exe'},bearerTokenProvider:async()=> 'synthetic-bearer-token-value',checkCredential:async()=>true,checkRegistry:async()=>true,
  publisherOptions:{historyTrust:{store_id:'relationship-gateway-v1',producer_ids:['cfo-relationship-worker']},getAuthorization:async()=> 'Bearer synthetic-history-token-value-1234',fetchImpl:async()=>{throw Error('network must not be called')},sse:{algorithm:'AES256'}},factories:{},
  reviewOptionsForRun:async run=>({resolution:{sourceAdapter:{load:async()=>({input:{binding:{run_id:run.run_id,catalog_manifest_sha256:run.manifest_sha256,room:'finance',source_index:'finance-cfo-source-docs',...source}}})}}}),
  createSubscriptionCandidateReview:async()=>({reviewCandidates:async input=>{reviewCalls++;assert.equal(input.bindings.length,1);assert.equal(input.candidates.length,1);return{schema:'resolution-review-receipt-v1',artifact_ref:publishedRef}}}),
 };
 const catalogPort={
  createController:async()=>({prepareTarget:async value=>{assert.deepEqual(value,target);return proposal}}),
  admit:async value=>{assert.equal(value,proposal);return{allowed:true,key:proposal.key,run_id:targetRun.run_id,manifest_sha256:targetRun.manifest_sha256}},
  workerBrokerForRun:run=>({prepareText:async()=>({run_id:run.run_id,outcome:'ready',snapshot_id:'txtsnap_'+'3'.repeat(64)})}),
  completePromotion:async value=>{completion=value;return{confirmed:true,key:proposal.key,run_id:targetRun.run_id,completion_sha256:'4'.repeat(64)}},
 };
 const historicalPort={readArtifact:async()=>({authority:{authenticated_gateway:true,current:true},payload:{schema:'resolution-history-v1',run:parentRun,caller_seat:'cfo',sources:[],events:[{operation:'accept',output:{accepted:false,candidate:{subject:'A',predicate:'related_to',object:'B'},evidence:{source_binding:source}}}],queries:[]}})};
 const gatewayPort={findPreparedBinding:async()=>({opaque:'prepared-binding'}),readiness:async()=>({coverage_ready:true,reason:'coverage_checked'})};
 const publisherPort={publish:async value=>{publishCalls++;return{run:value.run,producer_id:'cfo-relationship-worker',artifact_ref:value.artifact_ref}}};
 const runtime=await createCandidatePromotionRuntime({config:local,createRuntime:async()=>runtimePort,createCatalogClient:()=>catalogPort,createHistoricalReader:()=>historicalPort,createPromotionGateway:()=>gatewayPort,createPublisher:()=>publisherPort});
 const result=await runtime.run();assert.equal(result.run.run_id,targetRun.run_id);assert.equal(reviewCalls,1);assert.equal(publishCalls,1);assert.equal(extractorCalls,0);assert.equal(completion.proposal.key,proposal.key);assert.deepEqual(completion.parent_run,parentRun);assert.deepEqual(completion.source_refs,[source]);assert.equal(completion.artifact_ref.payload_sha256,publishedRef.payload_sha256);assert.equal(completion.producer_id,'cfo-relationship-worker');
 }finally{await rm(root,{recursive:true,force:true});}});
