import assert from 'node:assert/strict';
import test from 'node:test';

for(const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'}))process.env[key]??=value;
const enabled=!!process.env.RELATIONSHIP_STORE_MODULE;

test('published relationship query replays qualified X-to-Y-to-Z evidence and denies malformed, foreign, revoked and stale access',{skip:!enabled},async()=>{
 const {createAutoPublicationFixture}=await import(new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs',import.meta.url).href);
 const flags:any={},f=await createAutoPublicationFixture({flags});
 const post=(body:any)=>f.routes.app.inject({method:'POST',url:'/relationship-publications/v1/synthetic-history/synthetic-reviewer-1/query',headers:{authorization:'Bearer synthetic-history-token-value-1234','content-type':'application/json'},payload:JSON.stringify(body)});
 try{
  const histories=[];for(let index=0;index<3;index++){f.admit(index);const receipt=await f.reviewAndPublish(index);histories.push({run_id:f.fixtures[index].state.run.run_id,artifact_ref:receipt.artifact_ref});}const body={histories,query:f.query};
  const qualified=await post(body);assert.equal(qualified.statusCode,200,JSON.stringify({body:qualified.body,flags}));assert.equal(qualified.json().answer.status,'qualified');assert.equal(qualified.json().answer.premise_ids.length,3);assert.ok(qualified.json().answer.evidence.every((row:any)=>row.candidate.predicate==='depends_on'));
  const malformed=await post({...body,query:{cypher:'MATCH (n) RETURN n'}});assert.equal(malformed.statusCode,400);
  const foreign=await post({...body,histories:[{...histories[0],run_id:histories[1]!.run_id}]});assert.equal(foreign.statusCode,403);
  flags.deniedProducer=true;assert.equal((await post(body)).statusCode,403);flags.deniedProducer=false;
  flags.deniedSource=true;assert.equal((await post(body)).statusCode,403);flags.deniedSource=false;
  flags.changed=true;const stale=await post(body);assert.equal(stale.statusCode,200);assert.notEqual(stale.json().answer.status,'qualified');
  flags.changed=false;flags.sourceChecks=0;flags.revokeAfterChecks=3;assert.equal((await post(body)).statusCode,403);
 }finally{await f.routes.close();}
});
