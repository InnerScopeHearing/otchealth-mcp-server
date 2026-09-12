import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFullBackfillRuntime } from './full-backfill-cli.mjs';
import { createHistoricalRelationshipReader } from './historical-reader.mjs';
import { createPromotionGatewayClient } from './promotion-gateway-client.mjs';
import { createCandidatePromotionPlanner, createCandidatePromotionReview, createPreparedPromotionSourceRefresher, createPartitionCoverageAdapter, createPromotionLineageRecorder, createCandidatePromotionRunner } from './candidate-promotion.mjs';
import { createPromotionLineageIntentStore } from './promotion-lineage-intent.mjs';
import { createPublicationOutbox } from './publication-outbox.mjs';
import { createPagedRecallHost } from './paged-recall-host.mjs';
import { createRelationshipPublicationPipeline } from './publication-pipeline.mjs';

const HASH=/^[a-f0-9]{64}$/;const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,k)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===[...k].sort().join('\0');
const run=v=>exact(v,['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])&&v.ref_version==='neptune-trial-active-run-ref-v1'&&v.scope==='finance'&&/^run_[a-f0-9]{64}$/.test(v.run_id||'')&&HASH.test(v.manifest_sha256||'')&&typeof v.purpose==='string'&&typeof v.run_version==='string';
const ref=v=>exact(v,['schema','artifact_id','bucket','key','payload_sha256','version_id','size_bytes'])&&v.schema==='relationship-resolution-artifact-ref-v1'&&HASH.test(v.payload_sha256||'')&&v.artifact_id===`resart_${v.payload_sha256}`&&typeof v.version_id==='string'&&Number.isSafeInteger(v.size_bytes);
const target=v=>exact(v,['source_document_version','catalog_source_sha256'])&&/^docv_[a-f0-9]{64}$/.test(v.source_document_version||'')&&HASH.test(v.catalog_source_sha256||'');
async function json(path){const info=await stat(path);if(!info.isFile()||info.size>32768)fail('candidate_promotion_runtime_config');try{return JSON.parse(await readFile(path,'utf8'));}catch{fail('candidate_promotion_runtime_config');}}
function config(v){if(!exact(v,['schema','backfill_config','parent_artifact_ref','parent_run','target'])||v.schema!=='candidate-promotion-runtime-v2'||!isAbsolute(v.backfill_config)||!ref(v.parent_artifact_ref)||!run(v.parent_run)||!target(v.target))fail('candidate_promotion_runtime_config');return structuredClone(v);}
function args(argv){if(argv.length!==2||argv[0]!=='--config'||!argv[1])fail('candidate_promotion_runtime_arguments');return resolve(argv[1]);}

/** Actual production composition. It performs no model dispatch: target text preparation is
 * the existing version-pinned broker operation, while review consumes retained candidates. */
export async function createCandidatePromotionRuntime({config: raw, env=process.env, stdout=process.stdout, createRuntime=createFullBackfillRuntime, createCatalogClient}={}){
 const local=config(raw), backfill=await json(local.backfill_config), runtime=await createRuntime(backfill,env,stdout);
 if(!runtime?.host||typeof runtime.bearerTokenProvider!=='function'||typeof runtime.reviewOptionsForRun!=='function'||typeof runtime.createSubscriptionCandidateReview!=='function'||!runtime.publisherOptions||!runtime.factories)fail('candidate_promotion_runtime_unavailable');
 if(!backfill.registry||backfill.review_mode==='candidate-only'||typeof backfill.cto_root!=='string'||typeof backfill.producer!=='string'||typeof backfill.outbox_directory!=='string')fail('candidate_promotion_runtime_config');
 const catalogFactory=createCatalogClient??(await import(pathToFileURL(join(backfill.cto_root,'tools/neptune-trial/catalog-controller/gateway-client.mjs')).href)).createCatalogGatewayClient;
 const catalog=catalogFactory({cohort_id:runtime.host.cohort_id,seat:'cfo',bearerTokenProvider:runtime.bearerTokenProvider});
 if(typeof catalog?.createController!=='function'||typeof catalog?.admit!=='function'||typeof catalog?.workerBrokerForRun!=='function')fail('candidate_promotion_runtime_unavailable');
 const lineageStore=createPromotionLineageIntentStore(join(backfill.outbox_directory,'promotion-lineage'));
 async function buildPipeline(targetRun){
  const options=await runtime.reviewOptionsForRun(targetRun),gateway=createPromotionGatewayClient({run:targetRun,registryId:backfill.registry.id,bearerTokenProvider:runtime.bearerTokenProvider});
  const planner=createCandidatePromotionPlanner({readParent:createHistoricalRelationshipReader({gatewayOrigin:'https://mcp.otchealth.app',run:local.parent_run,producer:backfill.producer,historyTrust:runtime.publisherOptions.historyTrust,getAuthorization:runtime.publisherOptions.getAuthorization,fetchImpl:runtime.publisherOptions.fetchImpl,sse:runtime.publisherOptions.sse}),refreshSource:createPreparedPromotionSourceRefresher({findPreparedBinding:gateway.findPreparedBinding,sourceAdapter:options.resolution.sourceAdapter}),assertCovered:createPartitionCoverageAdapter({registryId:backfill.registry.id,readiness:gateway.readiness})});
  const review=createCandidatePromotionReview({planner,recordLineage:createPromotionLineageRecorder({store:lineageStore,cohort_id:runtime.host.cohort_id,producer_id:backfill.producer}),createSignedReview:async({run,signal})=>runtime.createSubscriptionCandidateReview(await runtime.reviewOptionsForRun(run,{signal}))});
  const publisher=createPagedRecallHost({...runtime.publisherOptions,...runtime.factories});
  return createRelationshipPublicationPipeline({cohort_id:runtime.host.cohort_id,producer_id:backfill.producer,outbox:createPublicationOutbox(backfill.outbox_directory),publisher,
   loadExtracted:async()=>({bindings:[],candidates:[],queries:[]}),createReview:async()=>({reviewCandidates:async()=>review.reviewCandidates({parent_artifact_ref:local.parent_artifact_ref,parent_run:local.parent_run,run:targetRun})})});
 }
 return Object.freeze({async run({signal}={}){
  await runtime.checkCredential();await runtime.checkRegistry();
  const controller=await catalog.createController({binary:runtime.host.binary,environment:env,extractorModel:backfill.extractor_model,signal});
  let pipeline;const runner=createCandidatePromotionRunner({prepareTarget:(value,options)=>controller.prepareTarget(value,options),admit:(proposal,options)=>catalog.admit(proposal,options),prepareText:async(targetRun,options)=>catalog.workerBrokerForRun(targetRun).prepareText({document_ordinal:0},options),pipeline:{process:async(proposal,options)=>{pipeline??=await buildPipeline(proposal.run);return pipeline.process(proposal,options);}}});
  return runner.run({target:local.target,parent_artifact_ref:local.parent_artifact_ref,parent_run:local.parent_run},{signal});
 }});
}
export async function runCandidatePromotionRuntimeCli({argv=process.argv.slice(2),env=process.env,stdout=process.stdout,stderr=process.stderr,load=json,create=createCandidatePromotionRuntime}={}){try{const local=config(await load(args(argv))),runtime=await create({config:local,env,stdout}),result=await runtime.run();stdout.write(JSON.stringify({schema:'candidate-promotion-runtime-receipt-v1',status:'complete',run_id:result.run.run_id,publication:result.publication.code})+'\n');return 0;}catch(error){const reason=['candidate_promotion_runtime_arguments','candidate_promotion_runtime_config','candidate_promotion_runtime_unavailable','candidate_promotion_admission_required','candidate_promotion_preparation_required','candidate_promotion_source_changed','candidate_promotion_source_uncovered','candidate_promotion_publication_incomplete'].includes(error?.code)?error.code:'candidate_promotion_runtime_unavailable';stderr.write(JSON.stringify({schema:'candidate-promotion-runtime-receipt-v1',status:'not_ready',reason})+'\n');return 2;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runCandidatePromotionRuntimeCli();
