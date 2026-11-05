import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CIO_SITE_ID='test';process.env.CIO_TRACK_KEY='test';process.env.CIO_APP_API_BEARER='test';process.env.PERPLEXITY_CONNECTOR_TOKEN='a'.repeat(32);process.env.ADMIN_REVOKE_TOKEN='b'.repeat(32);process.env.N8N_WEBHOOK_SECRET='c'.repeat(32);process.env.READ_ONLY_MODE='false';process.env.ENABLE_WRITE_TOOLS='true';process.env.DRY_RUN_DEFAULT='false';process.env.AUTO_JOURNAL_MODE='on';
const {registerCheckpoint}=await import('./checkpoint.js');
const {registerTool}=await import('../registry.js');
const {requestContext,currentCallerHash}=await import('../../server/request-context.js');
function fixture(){let handler:any;const captured:{logs:unknown[],journals:unknown[]}={logs:[],journals:[]};const counts={shield:0,journal:0,log:0,configured:0,deliver:0,reset:0,callerHash:0};
 const effects={inboundShield:async()=>{counts.shield++;return {ran:false,attackDetected:false,blocked:false,mode:'report'};},journalMutation:async(v:unknown)=>{counts.journal++;captured.journals.push(v);},logToolStart:(v:unknown)=>{counts.log++;captured.logs.push(v);}};
 registerCheckpoint({registerTool:(_n:any,_c:any,h:any)=>{handler=h;}} as never,()=>{counts.callerHash++;return currentCallerHash();},{register:((s:any,d:any,h:any)=>registerTool(s,d,h,false,effects as never)) as never,configured:()=>{counts.configured++;return true;},deliver:async()=>{counts.deliver++;return{id:'synthetic',stored:true,indexed:true};},reset:()=>{counts.reset++;}});
 return {handler,counts,captured};
}
async function invoke(caller:string,agent:string,dry_run=false){const f=fixture();const result=await requestContext.run({callerHash:'synthetic',correlationId:'synthetic',callerAgent:caller},()=>f.handler({agent,summary:'SYNTHETIC_PRIVATE_SENTINEL',dry_run}));await new Promise(resolve=>setImmediate(resolve));return {f,result};}

test('real registry rejects foreign or personal checkpoint before shield, logs, providers, stores or journal',async()=>{
 for(const [caller,target,dry] of [['coo','cto',false],['coo','clo-personal',false],['clo-personal','clo-personal',false],['coo','cto',true],['agents-shared','cto',false],['coo','agents-shared',false],['agents-shared','clo-personal',false],['clo-personal','agents-shared',false]] as const){
  const {f,result}=await invoke(caller,target,dry);assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'checkpoint_scope_forbidden');assert.equal(result.structuredContent.dry_run,dry);assert.deepEqual(f.counts,{shield:0,journal:0,log:0,configured:0,deliver:0,reset:0,callerHash:0});assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE_SENTINEL/);
 }
});

test('authorized same-seat invocation still reaches the real registry shield and handler',async()=>{
 const {f,result}=await invoke('coo','coo',true);assert.notEqual(result.isError,true);assert.equal(f.counts.shield,1);assert.equal(f.counts.log,1);assert.equal(f.counts.configured,1);assert.equal(f.counts.journal,0);
});

 test('authorized live-shaped call preserves functionality and keeps input out of logs and journal',async()=>{
 const f=fixture();
 const result=await requestContext.run({callerHash:'synthetic',correlationId:'synthetic',callerAgent:'coo'},()=>f.handler({agent:'coo',memories:[{kind:'fact',text:'SYNTHETIC_PRIVATE_SENTINEL'}],dry_run:false}));
 await new Promise(resolve=>setImmediate(resolve));
 assert.notEqual(result.isError,true);
 assert.equal(f.counts.shield,1);assert.equal(f.counts.configured,1);assert.ok(f.counts.deliver>=1);assert.equal(f.counts.reset,1);assert.equal(f.counts.journal,1);
 assert.doesNotMatch(JSON.stringify(f.captured),/SYNTHETIC_PRIVATE_SENTINEL/);
 });

test('shared company identity can checkpoint only its own lane through the real registry',async()=>{
 const {f,result}=await invoke('agents-shared','agents-shared',true);assert.notEqual(result.isError,true);assert.equal(f.counts.shield,1);assert.equal(f.counts.configured,1);
});
