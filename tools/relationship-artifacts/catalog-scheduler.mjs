import {createPublicationOutbox} from './publication-outbox.mjs';
import {createPagedRecallHost} from './paged-recall-host.mjs';
import {createCatalogExtractionLoader,createRelationshipPublicationPipeline} from './publication-pipeline.mjs';
/** Production entry point: invokes the actual catalog CLI/host with a required review/publication pipeline. */
export async function runRelationshipCatalogScheduler({runCatalogControllerCli,createSubscriptionCandidateReview,factories,reviewOptionsForRun,outboxDirectory,publisherOptions,argv,env,stdout,load,signal,onMonitor,brokerFactory,bearerTokenProvider,resumeCandidateOnly=false}={}){
 if(typeof runCatalogControllerCli!=='function'||typeof createSubscriptionCandidateReview!=='function'||typeof reviewOptionsForRun!=='function'||!factories||typeof onMonitor!=='function'||typeof resumeCandidateOnly!=='boolean')throw Error('relationship_scheduler_configuration');
 const outbox=createPublicationOutbox(outboxDirectory),publisher=createPagedRecallHost({...publisherOptions,...factories});let pipeline;
 const relationshipPipelineFactory=context=>{
  if(context.cohort_id!==publisherOptions.cohortId)throw Error('relationship_scheduler_cohort');
  if(!pipeline)pipeline=createRelationshipPublicationPipeline({cohort_id:context.cohort_id,producer_id:publisherOptions.producer,outbox,publisher,onMonitor,loadExtracted:createCatalogExtractionLoader(context),createReview:async({run,signal})=>{
   const options=await reviewOptionsForRun(run,{signal});if(options?.resolution?.run?.run_id!==run.run_id||options.resolution.callerSeat!=='cfo')throw Error('relationship_scheduler_scope');
   return createSubscriptionCandidateReview(options);
  }});if(!resumeCandidateOnly)return pipeline;return Object.freeze({process:(proposal,options={})=>pipeline.process(proposal,{...options,resumeCandidateOnly:true}),recover:(options={})=>pipeline.recover({...options,skipIntentOnly:true}),retrievePage:(...args)=>pipeline.retrievePage(...args)});
 };
 // Injection is also passed to an explicit broker constructor for faithful integration tests.
 const broker=brokerFactory?((local,options)=>brokerFactory(local,{...options,relationshipPipelineFactory})):undefined;
 return runCatalogControllerCli({argv,env,stdout,load,signal,relationshipPipelineFactory,bearerTokenProvider,...(broker?{brokerFactory:broker}:{})});
}
