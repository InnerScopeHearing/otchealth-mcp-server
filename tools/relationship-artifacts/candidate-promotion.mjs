import { createHash } from 'node:crypto';

const HASH=/^[a-f0-9]{64}$/, RUN=/^run_[a-f0-9]{64}$/, fail=code=>{throw Object.assign(Error(code),{code});};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
const exact=(v,k)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===[...k].sort().join('\0');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\0\r\n]/.test(v);
function run(v){if(!exact(v,['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])||v.ref_version!=='neptune-trial-active-run-ref-v1'||v.scope!=='finance'||!text(v.purpose)||!text(v.run_version)||!HASH.test(v.manifest_sha256)||!RUN.test(v.run_id))fail('candidate_promotion_run_invalid');const {run_id,...body}=v;if(run_id!==`run_${sha(body)}`)fail('candidate_promotion_run_invalid');return structuredClone(v);}
function artifact(v){if(!exact(v,['schema','artifact_id','bucket','key','payload_sha256','version_id','size_bytes'])||v.schema!=='relationship-resolution-artifact-ref-v1'||!text(v.artifact_id)||!text(v.bucket)||!text(v.key)||!HASH.test(v.payload_sha256)||v.artifact_id!==`resart_${v.payload_sha256}`||!text(v.version_id)||!Number.isSafeInteger(v.size_bytes)||v.size_bytes<0||v.size_bytes>16777216)fail('candidate_promotion_parent_invalid');return structuredClone(v);}
function sourceRef(v){if(!exact(v,['source_document_version','chunk_sha256'])||!text(v.source_document_version)||!HASH.test(v.chunk_sha256))fail('candidate_promotion_parent_invalid');return structuredClone(v);}
function candidate(v){if(!exact(v,['source_ref','candidate'])||!sourceRef(v.source_ref)||!v.candidate||typeof v.candidate!=='object'||Array.isArray(v.candidate)||Buffer.byteLength(canonical(v.candidate))>32768)fail('candidate_promotion_parent_invalid');return {source_ref:sourceRef(v.source_ref),candidate:structuredClone(v.candidate)};}
function promotedBinding(v,target,expected){if(!v||typeof v!=='object'||Array.isArray(v)||v.run_id!==target.run_id||v.catalog_manifest_sha256!==target.manifest_sha256||v.room!=='finance'||v.source_index!=='finance-cfo-source-docs'||v.source_document_version!==expected.source_document_version||v.chunk_sha256!==expected.chunk_sha256)fail('candidate_promotion_source_changed');return structuredClone(v);}

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
  const lineage=Object.freeze({schema:'candidate-promotion-lineage-v1',parent_artifact_ref:parent.artifact_ref,parent_run:parent.run,target_run:target,source_refs_sha256:sha([...index.keys()].sort())});
  return Object.freeze({schema:'candidate-promotion-plan-v1',lineage,review_input:Object.freeze({bindings:Object.freeze(bindings),candidates:Object.freeze(candidates),queries:Object.freeze([])})});
 }});
}

/** Uses the existing signed reviewer only after the planner has reconstructed a fresh, covered input. */
export function createCandidatePromotionReview({planner,createSignedReview}={}){
 if(typeof planner?.plan!=='function'||typeof createSignedReview!=='function')fail('candidate_promotion_configuration');
 return Object.freeze({async reviewCandidates(request,{signal}={}){const plan=await planner.plan(request,{signal}),review=await createSignedReview({run:plan.lineage.target_run,signal});if(typeof review?.reviewCandidates!=='function')fail('candidate_promotion_review_configuration');const receipt=await review.reviewCandidates(plan.review_input,{signal});if(receipt?.schema!=='resolution-review-receipt-v1'||!receipt.artifact_ref)fail('candidate_promotion_review_invalid');return Object.freeze({...receipt,promotion_lineage:plan.lineage});}});
}