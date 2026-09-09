// Synthetic-only acceptance proof against the actual CTO resolver and signed registry.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCrossRunRecall} from './cross-run-recall.mjs';
if (!process.argv[2]) throw Error('cto_root_required');
const root=resolve(process.argv[2]);
const load=p=>import(pathToFileURL(join(root,'tools/neptune-trial',p)).href);
const [{createSyntheticReview},resolver,{refreshIdentityReceipts},{createSignedIdentityRegistry}]=await Promise.all([
  load('subscription-review/synthetic-fixture.mjs'),load('relationship-resolution/resolver.mjs'),
  load('relationship-adapters/identity-currentness.mjs'),load('subscription-review/registry.mjs')]);
const f=createSyntheticReview(), batch=f.batch(), receipts=[];
for(const indices of [[0],[1,2]]) receipts.push(await f.build().review({
  bindings:indices.map(i=>batch.bindings[i]), admissions:indices.map((i,n)=>({...batch.admissions[i],source_index:n})),queries:[]}));
let revoked=false, accessDenied=false, sourceCurrent=true;
const {envelope,...config}=f.publicRegistryState();
const registry=createSignedIdentityRegistry({...config,readSnapshot:async()=>{if(revoked)throw Error('synthetic_registry_revoked');return envelope;}});
const producer='synthetic-reviewer-1', run=f.wire.state.run;
const reader={run_id:run.run_id,producer_id:producer,boundHistoryTrust:f.wire.options.historyTrust,
  async readArtifact(ref){if(accessDenied)throw Error('synthetic_history_denied');return{payload:await f.wire.store.getArtifact(ref),authority:{authenticated_gateway:true,
    policy_version:'synthetic-current-policy',expires_at:new Date(Date.now()+60000).toISOString(),producer_id:producer,caller_seat:'cfo',current:sourceCurrent}};}};
const recall=createCrossRunRecall({...resolver,refreshIdentityReceipts,readers:[reader],
  revalidateIdentity:async(request,options)=>(await registry.resolve(request,options))?.proof??null});
const histories=receipts.map(receipt=>({run,producer_id:producer,artifact_ref:receipt.artifact_ref}));
const qualified=await recall.recall({histories,query:batch.queries[0]});
assert.equal(qualified.answer.status,'qualified');
revoked=true;
const denied=await recall.recall({histories,query:{...batch.queries[0],premise_ids:qualified.answer.premise_ids}});
assert.equal(denied.answer.status,'invalidated');assert.equal(denied.answer.conclusion,null);
const candidates=await recall.recall({histories,query:{kind:'candidate_links'}});
assert.equal(candidates.answer.items.length,3);assert.ok(candidates.answer.items.every(r=>!r.identity_verified&&!r.accepted));
const absent=createCrossRunRecall({...resolver,readers:[reader]});
assert.notEqual((await absent.recall({histories,query:batch.queries[0]})).answer.status,'qualified');
revoked=false;
for(const mode of ['history','source']){
  let calls=0;accessDenied=false;sourceCurrent=true;
  const raced=createCrossRunRecall({...resolver,refreshIdentityReceipts,readers:[reader],revalidateIdentity:async(request,options)=>{
    const proof=(await registry.resolve(request,options))?.proof??null;
    if(++calls>6){if(mode==='history')accessDenied=true;else sourceCurrent=false;}
    return proof;
  }});
  if(mode==='history')await assert.rejects(raced.recall({histories,query:batch.queries[0]}));
  else assert.notEqual((await raced.recall({histories,query:batch.queries[0]})).answer.status,'qualified');
}
process.stdout.write(JSON.stringify({synthetic_only:true,qualified_before_revocation:true,invalidated_after_revocation:true,candidates_preserved:3,missing_authority_fails_closed:true,access_revoked_during_identity_refresh_denied:true})+'\n');
