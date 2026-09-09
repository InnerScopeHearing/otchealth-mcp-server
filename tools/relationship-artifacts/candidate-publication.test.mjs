import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {createAutoPublicationFixture,loadActualRelationshipModules} from './auto-publication-fixture.mjs';
import {createGatewayRelationshipStore} from './gateway-store.mjs';
for(const key of ['CIO_SITE_ID','CIO_TRACK_KEY','CIO_APP_API_BEARER','PERPLEXITY_CONNECTOR_TOKEN','ADMIN_REVOKE_TOKEN','N8N_WEBHOOK_SECRET'])process.env[key]??='synthetic-placeholder-value-000000000';
const enabled=!!process.env.RELATIONSHIP_CANDIDATE_CTO_ROOT&&!!process.env.RELATIONSHIP_STORE_MODULE;
test('candidate-only publication retrieves source-cited unverified candidates through reconstructed paged recall',{skip:!enabled},async()=>{
 const {createCandidateOnlyReview}=await import(pathToFileURL(join(process.env.RELATIONSHIP_CANDIDATE_CTO_ROOT,'tools/neptune-trial/subscription-review/candidate-only.mjs')).href),m=await loadActualRelationshipModules(),f=await createAutoPublicationFixture();
 try{
  for(let i=0;i<3;i++){
   f.admit(i);const fixture=f.fixtures[i],store=createGatewayRelationshipStore({createS3ResolutionStore:m.createS3ResolutionStore,gatewayOrigin:'https://synthetic-history.invalid',run:fixture.state.run,producer:'synthetic-reviewer-1',sse:{algorithm:'AES256'},historyTrust:fixture.options.historyTrust,authorizeArtifact:async()=>({allowed:true}),getAuthorization:async()=> 'Bearer synthetic-history-token-value-1234',fetchImpl:f.routes.fetchImpl});
   const review=createCandidateOnlyReview({resolution:{...fixture.options,store}}),batch=fixture.batch();
   const receipt=await review.reviewCandidates({bindings:batch.bindings,candidates:batch.admissions.map(a=>({source_index:a.source_index,candidate:a.input.candidate})),queries:[]});
   assert.ok(receipt.records.length);assert.ok(receipt.records.every(r=>r.accepted!==true));f.receipts[i]=receipt;await f.publish(i);
  }
  const query={kind:'candidate_links',limit:10},first=await f.host.retrievePage(query);assert.equal(first.recall.answer.status,'unverified_candidates');assert.equal(first.recall.answer.items.length,3);assert.ok(first.recall.answer.items.every(r=>r.semantic_verified===false));
  const restarted=await createAutoPublicationFixture({snapshot:f.snapshot});try{const recalled=await restarted.host.retrievePage(query);assert.equal(recalled.recall.answer.status,'unverified_candidates');assert.equal(recalled.recall.answer.items.length,3);}finally{await restarted.routes.close();}
 }finally{await f.routes.close();}
});
