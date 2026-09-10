import assert from 'node:assert/strict';
import test from 'node:test';

for (const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'})) process.env[key]??=value;
const { requestContext }=await import('../../server/request-context.js');
const { registerCfoRelationshipQuery }=await import('./relationship-query.js');
type Handler=(args:Record<string,unknown>)=>Promise<any>;
const callerHash='a'.repeat(64);
function capture(service:any){let handler:Handler|undefined;const server={registerTool(_name:string,_config:unknown,candidate:Handler){handler=candidate;return{remove(){}};}};registerCfoRelationshipQuery(server as never,()=>callerHash,service);assert.ok(handler);return handler;}
function invoke(handler:Handler,callerAgent:string,connectorSurface:boolean,args:Record<string,unknown>){return requestContext.run({callerHash,correlationId:'synthetic',callerAgent,connectorSurface},()=>handler(args));}

test('registered query is CFO connector only and forwards the bounded server-owned discovery request',async()=>{
 const calls:any[]=[];const service={query:async(input:any,ctx:any)=>{calls.push({input,ctx});return{schema:'relationship-publication-discovery-query-v1',discovery:{scanned_histories:1,next_after:null,scan_complete:true},answer:{status:'unverified_candidates',semantic_verified:false,conclusion:null,items:[]}};}};const handler=capture(service),args={cohort_id:'cfo-current',producer_id:'cfo-worker',query:{kind:'candidate_links',predicate:'owns'}};
 for(const [agent,connector] of [['cto',true],['clo',true],['clo-personal',true],['cfo',false]] as const){const denied=await invoke(handler,agent,connector,args);assert.equal(denied.structuredContent.result.error,'forbidden_cfo_only');}
 const accepted=await invoke(handler,'cfo',true,args);assert.equal(accepted.isError,undefined);assert.equal(accepted.structuredContent.result.result.answer.status,'unverified_candidates');assert.equal(calls.length,1);assert.deepEqual(calls[0].input,args);assert.equal(calls[0].ctx.caller_agent,'cfo');assert.equal(calls[0].ctx.connector_surface,true);
});

test('tool schema rejects caller-supplied histories and unbounded scan limits before discovery',async()=>{
 let calls=0;const handler=capture({query:async()=>{calls++;return{};}});
 const bad=await invoke(handler,'cfo',true,{cohort_id:'cfo-current',producer_id:'cfo-worker',scan_limit:65,histories:[],query:{kind:'candidate_links'}});
 assert.equal(bad.isError,true);assert.equal(calls,0);
});
