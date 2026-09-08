import {createGatewayRelationshipStore} from './gateway-store.mjs';
import {createHistoricalRelationshipReader} from './historical-reader.mjs';
import {createCrossRunRecall} from './cross-run-recall.mjs';
import {createFileRecallJournal,createRelationshipRecallHost} from './recall-journal.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';

/**
 * No credential, execution, source, or history-authorization defaults. The catalog
 * host supplies reviewed run configuration and verifies actual server admissions.
 * New reviews still use the existing execution-guarded store; recall only uses GET.
 */
export function createRelationshipHostComposition({factories,runs,gatewayOrigin,journalDirectory,
 getAuthorization,fetchImpl,verifyAdmission,now=Date.now}={}){
 if(!factories||['createResolver','bindPreparedSource','verificationRequestHash','createDurableResolution','createS3ResolutionStore'].some(k=>typeof factories[k]!=='function')||!Array.isArray(runs)||!runs.length||typeof verifyAdmission!=='function')throw Error('relationship_host_configuration');
 const configurations=new Map(),readers=[];
 for(const entry of runs){
  const {run,producer,historyTrust,sse,sourceAdapter,verifiers,authorizeHistory,authorizeArtifact,recordedAt}=entry;
  const key=run?.run_id+'/'+producer;if(configurations.has(key)||typeof authorizeHistory!=='function'||typeof authorizeArtifact!=='function'||typeof recordedAt!=='function'||typeof sourceAdapter?.load!=='function'||typeof sourceAdapter?.check!=='function')throw Error('relationship_host_configuration');
  const reader=createHistoricalRelationshipReader({gatewayOrigin,run,producer,historyTrust,sse,getAuthorization,fetchImpl,now});
  const store=createGatewayRelationshipStore({createS3ResolutionStore:factories.createS3ResolutionStore,gatewayOrigin,run,producer,historyTrust:reader.boundHistoryTrust,sse,getAuthorization,fetchImpl,authorizeArtifact});
  configurations.set(key,{run:structuredClone(run),producer,workflow:factories.createDurableResolution({run,callerSeat:'cfo',store,sourceAdapter,verifiers,authorizeHistory,recordedAt,historyTrust:store.boundHistoryTrust,now})});readers.push(reader);
 }
 const recall=createCrossRunRecall({...factories,readers,now}),journal=createFileRecallJournal(journalDirectory);
 const host=createRelationshipRecallHost({journal,recall,verifyAdmission,readers});
 return Object.freeze({
  admitted:host.admitted,retrieve:host.retrieve,inspect:host.inspect,publish:host.publish,publishReviewed:host.publish,
  async reviewAndPublish(entry,batch,{signal}={}){
   const config=configurations.get(entry?.run?.run_id+'/'+entry?.producer_id);if(!config||canonical(entry.run)!==canonical(config.run))throw Error('relationship_host_scope');
   await host.admitted(entry);
   const receipt=await config.workflow.review(batch,{signal});
   // Failure to obtain historical-read authority leaves the existing published set
   // intact. Retain this exact reviewed receipt in the caller's durable job result.
   await host.publish(entry,receipt.artifact_ref,{signal});return receipt;
  },
 });
}
