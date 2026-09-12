import { createHash } from 'node:crypto';

const HASH=/^[a-f0-9]{64}$/, RUN=/^run_[a-f0-9]{64}$/, fail=code=>{throw Object.assign(Error(code),{code});};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
const exact=(v,k)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===[...k].sort().join('\0');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\0\r\n]/.test(v);
function run(v){if(!exact(v,['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])||v.ref_version!=='neptune-trial-active-run-ref-v1'||v.scope!=='finance'||!text(v.purpose)||!text(v.run_version)||!HASH.test(v.manifest_sha256)||!RUN.test(v.run_id))fail('candidate_promotion_run_invalid');const {run_id,...body}=v;if(run_id!==`run_${sha(body)}`)fail('candidate_promotion_run_invalid');return structuredClone(v);}
function artifact(v){if(!exact(v,['schema','artifact_id','bucket','key','payload_sha256','version_id','size_bytes'])||v.schema!=='relationship-resolution-artifact-ref-v1'||!text(v.artifact_id)||!text(v.bucket)||!text(v.key)||!HASH.test(v.payload_sha256)||v.artifact_id!==`resart_${v.payload_sha256}`||!text(v.version_id)||!Number.isSafeInteger(v.size_bytes)||v.size_bytes<0||v.size_bytes>16777216)fail('candidate_promotion_parent_invalid');return structuredClone(v);}
function sourceRef(v){if(!exact(v,['source_document_version','catalog_source_sha256','chunk_sha256'])||!text(v.source_document_version)||!HASH.test(v.catalog_source_sha256)||!HASH.test(v.chunk_sha256))fail('candidate_promotion_parent_invalid');return structuredClone(v);}
function candidate(v){if(!exact(v,['source_ref','candidate'])||!sourceRef(v.source_ref)||!v.candidate||typeof v.candidate!=='object'||Array.isArray(v.candidate)||Buffer.byteLength(canonical(v.candidate))>32768)fail('candidate_promotion_parent_invalid');return {source_ref:sourceRef(v.source_ref),candidate:structuredClone(v.candidate)};}
function promotedBinding(v,target,expected){if(!v||typeof v!=='object'||Array.isArray(v)||v.run_id!==target.run_id||v.catalog_manifest_sha256!==target.manifest_sha256||v.room!=='finance'||v.source_index!=='finance-cfo-source-docs'||v.source_document_version!==expected.source_document_version||v.catalog_source_sha256!==expected.catalog_source_sha256||v.chunk_sha256!==expected.chunk_sha256)fail('candidate_promotion_source_changed');return structuredClone(v);}

/** Revalidates retained candidate evidence into a new signed-review lineage. It never writes,
 * extracts, or changes the parent artifact. Persistence is delegated to the existing new-run outbox. */
export function createCandidatePromotionPlanner({readParent,refreshSource,assertCovered}={}){
 if(typeof readParent!=='function'||typeof refreshSource!=='function'||typeof assertCovered!=='function')fail('candidate_promotion_configuration');
 return Object.freeze({async plan({parent_artifact_ref,parent_run,run:target_run},{signal}={}){
  const parent={artifact_ref:artifact(parent_artifact_ref),run:run(parent_run)},target=run(target_run);
  if(parent.run.run_id===target.run_id)fail('candidate_promotion_lineage_invalid');
  const saved=await readParent(parent,{signal});
  if(!exact(saved,['schema','artifact_ref','run','candidates'])||saved.schema!=='candidate-promotion-parent-v1'||canonical(artifact(saved.artifact_ref))!==canonical(parent.artifact_ref)||canonical(run(saved.run))!==canonical(parent.run)||!Array.isArray(saved.candidates)||saved.candidates.length<1||saved.candidates.length>1000)fail('candidate_promotion_parent_invalid');
  const bindings=[],index=new Map(),candidates=[];
  for(const raw of saved.candidates){const item=candidate(raw),key=canonical(item.source_ref);let sourceIndex=index.get(key);if(sourceIndex===undefined){const refreshed=promotedBinding(await refreshSource({parent,source_ref:item.source_ref,run:target},{signal}),target,item.source_ref);if(await assertCovered(refreshed,{signal})!==true)fail('candidate_promotion_source_uncovered');sourceIndex=bindings.length;index.set(key,sourceIndex);bindings.push(refreshed);}candidates.push({source_index:sourceIndex,candidate:item.candidate});}
  const source_refs=Object.freeze([...index.keys()].sort().map(key=>Object.freeze(JSON.parse(key))));
  const lineage=Object.freeze({schema:'candidate-promotion-lineage-v2',parent_artifact_ref:parent.artifact_ref,parent_run:parent.run,target_run:target,source_refs,source_refs_sha256:sha(source_refs)});
  return Object.freeze({schema:'candidate-promotion-plan-v1',lineage,review_input:Object.freeze({bindings:Object.freeze(bindings),candidates:Object.freeze(candidates),queries:Object.freeze([])})});
 }});
}


/** Obtains a target-run binding from the catalog controller, then asks the existing
 * prepared-source factory to verify and return its authoritative binding. */
export function createPreparedPromotionSourceRefresher({findPreparedBinding,sourceAdapter}={}){
 if(typeof findPreparedBinding!=='function'||typeof sourceAdapter?.load!=='function')fail('candidate_promotion_configuration');
 return async({source_ref,run:target},{signal}={})=>{
  const requested=await findPreparedBinding({source_ref:structuredClone(source_ref),target:structuredClone(target)},{signal});
  const loaded=await sourceAdapter.load(requested,{signal}),binding=loaded?.input?.binding;
  return promotedBinding(binding,target,source_ref);
 };
}
/** Uses the authenticated registry readiness contract, which checks exact binding coverage without a synthetic mention. */
export function createPartitionCoverageAdapter({registryId,readiness}={}){
 if(!text(registryId)||typeof readiness!=='function')fail('candidate_promotion_configuration');
 return async(binding,{signal}={})=>{
  if(!text(binding?.source_document_version)||!HASH.test(binding?.chunk_sha256)||!RUN.test(binding?.run_id))fail('candidate_promotion_source_changed');
  const source_binding_sha256=sha({source_document_version:binding.source_document_version,source_sha256:binding.chunk_sha256});
  const result=await readiness({registry_id:registryId,run_id:binding.run_id,source_binding_sha256},{signal});
  return result?.coverage_ready===true&&result?.reason==='coverage_checked';
 };
}

/** Reads the existing authenticated immutable resolution-history envelope. Only unverified
 * accepted-candidate records are selected, and their exact prepared-source binding is retained. */
export function createHistoricalCandidateParentReader({reader}={}){
 if(typeof reader?.readArtifact!=='function')fail('candidate_promotion_configuration');
 return async(parent,{signal}={})=>{
  const result=await reader.readArtifact(parent.artifact_ref,{signal}),payload=result?.payload;
  if(result?.authority?.authenticated_gateway!==true||result.authority.current!==true||!exact(payload,['schema','run','caller_seat','sources','events','queries'])||payload.schema!=='resolution-history-v1'||payload.caller_seat!=='cfo'||canonical(run(payload.run))!==canonical(parent.run)||!Array.isArray(payload.events))fail('candidate_promotion_parent_invalid');
  const candidates=[];for(const event of payload.events){const record=event?.operation==='accept'?event.output:null,source=record?.evidence?.source_binding;if(record?.accepted===false&&record?.candidate&&source&&text(source.source_document_version)&&HASH.test(source.catalog_source_sha256)&&HASH.test(source.chunk_sha256))candidates.push({source_ref:{source_document_version:source.source_document_version,catalog_source_sha256:source.catalog_source_sha256,chunk_sha256:source.chunk_sha256},candidate:record.candidate});}
  return Object.freeze({schema:'candidate-promotion-parent-v1',artifact_ref:parent.artifact_ref,run:parent.run,candidates:Object.freeze(candidates)});
 };
}

/** Records lineage separately before delegating to the unchanged signed-review receipt contract. */
export function createCandidatePromotionReview({planner,createSignedReview,recordLineage}={}){
 if(typeof planner?.plan!=='function'||typeof createSignedReview!=='function'||typeof recordLineage!=='function')fail('candidate_promotion_configuration');
 return Object.freeze({async reviewCandidates(request,{signal}={}){const plan=await planner.plan(request,{signal});if(await recordLineage(plan.lineage,{signal})!==true)fail('candidate_promotion_intent_unavailable');const review=await createSignedReview({run:plan.lineage.target_run,signal});if(typeof review?.reviewCandidates!=='function')fail('candidate_promotion_review_configuration');const receipt=await review.reviewCandidates(plan.review_input,{signal});if(receipt?.schema!=='resolution-review-receipt-v1'||!receipt.artifact_ref)fail('candidate_promotion_review_invalid');return receipt;}});
}

/** Adapts the create-only durable lineage store to the signed-review boundary.
 * Replays of the same target run and exact lineage succeed idempotently. */
export function createPromotionLineageRecorder({store,cohort_id,producer_id}={}){
 if(typeof store?.create!=='function'||!/^[a-z][a-z0-9-]{0,63}$/.test(cohort_id)||!/^[a-z][a-z0-9-]{0,63}$/.test(producer_id))fail('candidate_promotion_configuration');
 return async(lineage,{signal}={})=>{
  if(signal?.aborted)fail('candidate_promotion_cancelled');
  const target=run(lineage?.target_run);
  await store.create({cohort_id,producer_id,run:target},lineage);
  return true;
 };
}

/** Drives the promotion-only transition. Preparation may materialize the exact target text
 * snapshot, but this runner has no worker/model dependency and never invokes extraction. */
export function createCandidatePromotionRunner({prepareTarget,admit,prepareText,pipeline,completePromotion}={}){
 if(typeof prepareTarget!=='function'||typeof admit!=='function'||typeof prepareText!=='function'||typeof pipeline?.process!=='function'||typeof completePromotion!=='function')fail('candidate_promotion_configuration');
 return Object.freeze({async run({target,...request},{signal}={}){
  if(!target||!exact(target,['source_document_version','catalog_source_sha256'])||!text(target.source_document_version)||!HASH.test(target.catalog_source_sha256))fail('candidate_promotion_target_invalid');
  const proposal=await prepareTarget({source_document_version:target.source_document_version,catalog_source_sha256:target.catalog_source_sha256},{signal});
  const targetRun=run(proposal?.run);if(!HASH.test(proposal?.key||'')||proposal.status!=='prepared'||proposal.manifest?.documents?.length!==1||proposal.manifest.documents[0].document_version_id!==target.source_document_version||proposal.manifest.documents[0].source_version!==target.catalog_source_sha256)fail('candidate_promotion_target_invalid');
  const admission=await admit(proposal,{signal});if(admission?.allowed!==true||admission.run_id!==targetRun.run_id||admission.key!==proposal.key||admission.manifest_sha256!==targetRun.manifest_sha256)fail('candidate_promotion_admission_required');
  const preparation=await prepareText(targetRun,{signal});if(preparation?.run_id!==targetRun.run_id||preparation.outcome!=='ready'||!/^txtsnap_[a-f0-9]{64}$/.test(preparation.snapshot_id||''))fail('candidate_promotion_preparation_required');
  const result=await pipeline.process(proposal,{signal,request:{...request,run:targetRun}});if(result?.status!=='complete'||result.run_id!==targetRun.run_id)fail('candidate_promotion_publication_incomplete');
  const completion=await completePromotion({proposal,targetRun,publication:structuredClone(result),parent_artifact_ref:request.parent_artifact_ref,parent_run:request.parent_run},{signal});if(completion?.confirmed!==true||completion.key!==proposal.key||completion.run_id!==targetRun.run_id||!HASH.test(completion.completion_sha256||''))fail('candidate_promotion_completion_unconfirmed');
  return Object.freeze({run:targetRun,publication:structuredClone(result),completion:structuredClone(completion)});
 }});
}
