import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CIO_SITE_ID='test';process.env.CIO_TRACK_KEY='test';process.env.CIO_APP_API_BEARER='test';process.env.PERPLEXITY_CONNECTOR_TOKEN='a'.repeat(32);process.env.ADMIN_REVOKE_TOKEN='b'.repeat(32);process.env.N8N_WEBHOOK_SECRET='c'.repeat(32);process.env.READ_ONLY_MODE='false';process.env.ENABLE_WRITE_TOOLS='true';process.env.DRY_RUN_DEFAULT='false';
const {registerCheckpoint,handleCheckpoint}=await import('./checkpoint.js');
const {requestContext,currentCallerHash}=await import('../../server/request-context.js');
function setup(){let handler:any;let configured=0;const writes:any[]=[];let resets=0;
 registerCheckpoint({registerTool:(_n:any,_c:any,h:any)=>{handler=h;}} as never,currentCallerHash,{configured:()=>{configured++;return true;},reset:()=>{resets++;},deliver:async(agent,kind)=>{writes.push({agent,kind});return{id:'synthetic',stored:true,indexed:true};}});
 return {handler,writes,get configured(){return configured;},get resets(){return resets;}};
}
async function run(callerAgent:string,agent:string,dry_run:boolean){const f=setup();const response=await requestContext.run({callerHash:'synthetic-hash',correlationId:'synthetic',callerAgent},()=>f.handler({agent,memories:[{kind:'fact',text:'Synthetic checkpoint'}],dry_run}));return {f,response};}

test('direct checkpoint refuses foreign, protected, missing and malformed identities before storage',async()=>{
 for(const [caller,target] of [['coo','cto'],['coo','clo-personal'],['clo-personal','clo-personal'],['','cto'],['../invalid','cto'],['coo','../invalid'],['external-read','external-read'],['unknown','unknown'],['agents-shared','cto'],['coo','agents-shared'],['agents-shared','clo-personal'],['clo-personal','agents-shared']]){
  const {f,response}=await run(caller,target,false);assert.equal(f.configured,0,`${caller}/${target}`);assert.deepEqual(f.writes,[]);assert.equal(f.resets,0);assert.match(JSON.stringify(response),/checkpoint_scope_forbidden/);
 }
});

test('scope refusal also precedes dry-run previews',async()=>{const {f,response}=await run('coo','cto',true);assert.equal(f.configured,0);assert.deepEqual(f.writes,[]);assert.match(JSON.stringify(response),/checkpoint_scope_forbidden/);});

test('same-seat checkpoint and same-seat dry run preserve behavior',async()=>{
 const actual=await run('coo',' COO ',false);assert.deepEqual(actual.f.writes.map(x=>x.agent),['coo','coo']);assert.equal(actual.f.resets,1);
 const preview=await run('coo','coo',true);assert.deepEqual(preview.f.writes,[]);assert.equal(preview.f.resets,0);assert.match(JSON.stringify(preview.response),/DRY RUN/);
});

test('each named company lane including the dedicated WeFunder lane can checkpoint itself',async()=>{
 for(const lane of ['cto','developer','cfo','clo','coo','cro','cpo','cco','exec','wefunder-campaign-director','agents-shared']){const {f}=await run(lane,lane,false);assert.deepEqual(f.writes.map(x=>x.agent),[lane,lane],lane);}
});

test('direct worker adapter refuses foreign target before checking configured store',async()=>{
 const result=await handleCheckpoint({agent:'cto',memories:[]},{callerHash:'synthetic',callerAgent:'coo',correlationId:'synthetic',dryRun:false,acknowledgeWarning:false});assert.match(JSON.stringify(result),/checkpoint_scope_forbidden/);
});
