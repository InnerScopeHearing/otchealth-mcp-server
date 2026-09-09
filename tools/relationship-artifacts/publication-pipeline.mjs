import {createHash} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const active=s=>{if(s?.aborted)fail('relationship_pipeline_cancelled');};
const same=(a,b)=>canonical(a)===canonical(b);
/** Load only already-completed immutable extractor results, never invoke extraction. */
export function createCatalogExtractionLoader({store,operationStoreForRun}){
 if(typeof store?.read!=='function'||typeof operationStoreForRun!=='function')fail('relationship_pipeline_configuration');
 return async(proposal,{signal}={})=>{
  active(signal);if(!/^[a-f0-9]{64}$/.test(proposal?.key??''))fail('relationship_extraction_invalid');
  const saved=await store.read('versions/'+proposal.key,{signal}),v=saved?.value,p=v?.proposal;
  if(v?.schema!=='catalog-controller-version-v1'||v.status!=='complete'||!same(p?.run,proposal.run)||p.key!==proposal.key||!same(p.manifest,proposal.manifest)||v.outcome?.code!=='document_canary_complete'||!Array.isArray(v.chunks)||!v.chunks.length||v.chunks.length>64||v.preparation?.chunk_count!==v.chunks.length)fail('relationship_extraction_incomplete');
  const operations=operationStoreForRun(proposal.run),bindings=[],candidates=[];let candidateBytes=2;
  for(let i=0;i<v.chunks.length;i++){
   active(signal);const chunk=v.chunks[i];if(chunk.chunk_ordinal!==i||chunk.status!=='complete'||!/^subop_[a-f0-9]{64}$/.test(chunk.operation_id))fail('relationship_extraction_invalid');
   const op=await operations.getOperation(chunk.operation_id,{signal}),res=await operations.getResult(chunk.operation_id,{signal}),spec=op?.operation?.spec,b=spec?.source_binding,output=res?.result?.output;
   if(!spec||op.operation.operation_id!==chunk.operation_id||'subop_'+sha(canonical(spec))!==chunk.operation_id||spec.purpose!==proposal.run.purpose||b?.run_id!==proposal.run.run_id||b.room!=='finance'||b.source_index!=='finance-cfo-source-docs'||b.catalog_manifest_sha256!==proposal.run.manifest_sha256||b.document_ordinal!==0||b.chunk_ordinal!==i||b.source_document_version!==p.manifest.documents[0].document_version_id||b.catalog_source_sha256!==p.manifest.documents[0].source_version||b.snapshot_id!==v.preparation.snapshot_id||b.prepared_manifest_sha256!==v.preparation.prepared_manifest_sha256||b.sidecar_content_sha256!==v.preparation.sidecar_content_sha256||!res?.result||res.result_sha256!==sha(canonical(res.result))||res.result.operation_id!==chunk.operation_id||res.result.spec_sha256!==sha(canonical(spec))||output?.provider!==spec.provider||output.model!==spec.model||output.billing_route!=='chatgpt_subscription'||output.paid_fallback!==false||output.source_sha256!==b.chunk_sha256||!Array.isArray(output.candidates))fail('relationship_extraction_invalid');
   if(output.candidates.length>1000-candidates.length)fail('relationship_extraction_limit');bindings.push(structuredClone(b));for(const candidate of output.candidates){const item={source_index:i,candidate};candidateBytes+=Buffer.byteLength(canonical(item))+(candidates.length?1:0);if(candidateBytes>1048576)fail('relationship_extraction_limit');candidates.push(structuredClone(item));}
  }
  active(signal);return{bindings,candidates,queries:[]};
 };
}
/** The injected reviewer is the actual subscription candidate adapter, not verifier defaults. */
export function createRelationshipPublicationPipeline({cohort_id,producer_id,outbox,publisher,loadExtracted,createReview,now=Date.now,onMonitor=()=>{}}={}){
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(cohort_id)||! /^[a-z][a-z0-9-]{0,63}$/.test(producer_id)||['get','createIntent','createReviewed','markPublished','pagePending'].some(k=>typeof outbox?.[k]!=='function')||typeof publisher?.publish!=='function'||typeof createReview!=='function'||typeof loadExtracted!=='function'||typeof now!=='function'||typeof onMonitor!=='function')fail('relationship_pipeline_configuration');
 const identity=run=>({cohort_id,producer_id,run:structuredClone(run)});
 const status=(id,state,code)=>({status:state,code,run_id:id.run.run_id});
 async function publish(id,item,signal){
  active(signal);try{const receipt=await publisher.publish({run:id.run,artifact_ref:item.receipt.artifact_ref},{signal});active(signal);if(!same(receipt.run,id.run)||receipt.producer_id!==producer_id||!same(receipt.artifact_ref,item.receipt.artifact_ref))fail('relationship_publication_receipt_mismatch');await outbox.markPublished(id,item.receipt);return status(id,'complete','relationship_published');}
  catch(error){return status(id,signal?.aborted?'cancelled':error?.code==='paged_recall_forbidden'?'denied':'unknown',signal?.aborted?'relationship_cancelled':error?.code==='paged_recall_forbidden'?'relationship_publication_denied':'relationship_publication_pending');}
 }
 async function process(proposal,{signal,recoveryOnly=false}={}){
  const id=identity(proposal.run);active(signal);const old=await outbox.get(id);
  if(old?.state==='published')return status(id,'complete','relationship_published');
  if(old?.state==='reviewed')return publish(id,old,signal);
  if(old?.state==='intent_only')return status(id,'held','relationship_review_unknown');
  if(recoveryOnly)return status(id,'held','relationship_review_not_started');
  const input=await loadExtracted(proposal,{signal});active(signal);const claim=await outbox.createIntent(id);if(!claim.created)return status(id,'held','relationship_review_unknown');
  let reviewed;
  try{const adapter=await createReview({run:id.run,signal});if(typeof adapter?.reviewCandidates!=='function')fail('relationship_review_configuration');reviewed=await adapter.reviewCandidates(input,{signal});active(signal);if(reviewed?.schema!=='resolution-review-receipt-v1'||!reviewed.artifact_ref)fail('relationship_review_receipt_invalid');await outbox.createReviewed(id,{artifact_ref:reviewed.artifact_ref});}
  catch(error){const paused=error?.code==='subscription_review_incomplete'&&error.review_status==='paused';return status(id,signal?.aborted?'cancelled':paused?'paused':'held',signal?.aborted?'relationship_cancelled':paused?'relationship_review_paused':'relationship_review_unknown');}
  return publish(id,await outbox.get(id),signal);
 }
 let recoveryCursor=null;
 async function recover({signal,limit=10,after=recoveryCursor}={}){
  if(!Number.isInteger(limit)||limit<1||limit>10)fail('relationship_pipeline_limit');active(signal);const page=await outbox.pagePending({after,limit}),events=[];let oldest=0;
  for(const item of page.items){active(signal);if(item.identity.cohort_id!==cohort_id||item.identity.producer_id!==producer_id)fail('relationship_outbox_scope');oldest=Math.max(oldest,now()-Date.parse(item.created_at));const result=item.state==='reviewed'?await publish(item.identity,item,signal):status(item.identity,'held','relationship_review_unknown');events.push(result);}
  const monitor={schema:'relationship-publication-monitor-v1',scope:'page',observed_at:new Date(now()).toISOString(),scanned_nodes:page.scanned_nodes,pending_observed:page.items.length,oldest_pending_age_ms:Math.max(0,oldest),published:events.filter(x=>x.status==='complete').length,held:events.filter(x=>x.status!=='complete').length,scan_complete:page.next_after===null};await onMonitor(monitor);
  recoveryCursor=page.next_after;return{status:events.find(x=>x.status!=='complete')?.status??(page.next_after?'dispatching':'complete'),code:events.some(x=>x.status!=='complete')?'relationship_recovery_held':page.next_after?'relationship_recovery_page':'relationship_recovery_complete',events,next_after:page.next_after,monitor};
 }
 return Object.freeze({process,recover,retrievePage:(...args)=>publisher.retrievePage(...args)});
}
