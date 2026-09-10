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
  const discover=(payload:any)=>f.routes.app.inject({method:'POST',url:'/relationship-publications/v1/synthetic-history/synthetic-reviewer-1/discover-query',headers:{authorization:'Bearer synthetic-history-token-value-1234','content-type':'application/json'},payload:JSON.stringify(payload)});
  const discovered=await discover({query:f.query});assert.equal(discovered.statusCode,200,discovered.body);assert.equal(discovered.json().answer.status,'qualified');assert.equal(discovered.json().discovery.scan_complete,true);assert.equal(discovered.json().discovery.scanned_histories,3);assert.ok(discovered.json().answer.evidence.every((row:any)=>/^[a-f0-9]{64}$/.test(row.evidence.passage_sha256)&&row.evidence.source_binding));
  const candidates=await discover({query:{kind:'candidate_links',include_stale:true}});assert.equal(candidates.statusCode,200,candidates.body);assert.equal(candidates.json().answer.status,'unverified_candidates');assert.equal(candidates.json().answer.semantic_verified,false);assert.ok(candidates.json().answer.items.every((row:any)=>row.semantic_verified===false&&row.epistemic_status==='candidate'&&row.evidence.source_binding));
  const arbitrary=await discover({query:{kind:'candidate_links',predicate:'owns'}});assert.equal(arbitrary.statusCode,200,arbitrary.body);assert.equal(arbitrary.json().answer.status,'unverified_candidates');assert.equal(arbitrary.json().answer.conclusion,null);assert.ok(arbitrary.json().answer.items.every((row:any)=>row.candidate.predicate==='owns'&&row.semantic_verified===false));
  flags.changed=true;const discoveredStale=await discover({query:f.query});assert.equal(discoveredStale.statusCode,200,discoveredStale.body);assert.notEqual(discoveredStale.json().answer.status,'qualified');flags.changed=false;
  const crossPage=await discover({scan_limit:2,query:f.query});assert.equal(crossPage.statusCode,200,crossPage.body);assert.equal(crossPage.json().answer.status,'qualified');assert.equal(crossPage.json().discovery.scanned_histories,3);assert.equal(crossPage.json().discovery.scan_complete,true);
  const partial=await discover({scan_limit:2,history_limit:2,query:f.query});assert.equal(partial.statusCode,200,partial.body);assert.equal(partial.json().answer.status,'incomplete');assert.equal(partial.json().answer.conclusion,null);assert.equal(partial.json().discovery.scan_complete,false);assert.match(partial.json().discovery.next_after,/^run_[a-f0-9]{64}$/);
  assert.equal((await discover({scope:'legal_company',query:f.query})).statusCode,403);
  for(const offset of [-1,0.5,'1',102401])assert.equal((await discover({query:{kind:'candidate_links',offset}})).statusCode,400);
  for(const limit of [-1,0,0.5,'1',101])assert.equal((await discover({query:{kind:'candidate_links',limit}})).statusCode,400);
  flags.sourceChecks=0;assert.equal((await discover({query:{kind:'candidate_links'}})).statusCode,200);const totalCandidateChecks=flags.sourceChecks;assert.ok(totalCandidateChecks>3);
  flags.sourceChecks=0;flags.revokeAfterChecks=totalCandidateChecks-1;assert.equal((await discover({query:{kind:'candidate_links'}})).statusCode,403);delete flags.revokeAfterChecks;
  flags.callerAgent='clo';assert.equal((await discover({scope:'finance',query:f.query})).statusCode,403);flags.callerAgent='clo-personal';assert.equal((await discover({scope:'legal_company',query:f.query})).statusCode,403);delete flags.callerAgent;
  const malformed=await post({...body,query:{cypher:'MATCH (n) RETURN n'}});assert.equal(malformed.statusCode,400);
  const foreign=await post({...body,histories:[{...histories[0],run_id:histories[1]!.run_id}]});assert.equal(foreign.statusCode,403);
  flags.deniedProducer=true;assert.equal((await post(body)).statusCode,403);flags.deniedProducer=false;
  flags.deniedSource=true;assert.equal((await post(body)).statusCode,403);flags.deniedSource=false;
  flags.changed=true;const stale=await post(body);assert.equal(stale.statusCode,200);assert.notEqual(stale.json().answer.status,'qualified');
  flags.changed=false;flags.sourceChecks=0;flags.revokeAfterChecks=3;assert.equal((await post(body)).statusCode,403);
 }finally{await f.routes.close();}
});
