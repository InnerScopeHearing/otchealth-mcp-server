import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { pathToFileURL } from 'node:url';
import '../../tools/relationship-artifacts/gateway-store.test.mjs';
for (const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'})) process.env[key]??=value;
const {registerRelationshipArtifactGatewayRoutes,relationshipArtifactGatewayTest:h}=await import('./relationship-artifact-gateway.js');
const {canonical,hash}=h;
function fixture(runOverride?:any,producer='synthetic-producer'){
 const content={ref_version:'neptune-trial-active-run-ref-v1',purpose:'company_graph_backfill',scope:'finance',run_version:'synthetic-v1',manifest_sha256:hash('synthetic manifest')};
 const run=runOverride??{...content,run_id:'run_'+hash(canonical(content))};
 const callerHash=hash('synthetic credential fingerprint');
 const ctx={caller_agent:'cfo',caller_hash:callerHash,raw_token:'synthetic-fixture',connector_surface:true,m365_static_auth:false};
 const binding={authenticated_caller:'cfo',caller_hash:callerHash,producer_id:producer,run,encryption:{algorithm:'AES256'}};
 const now=Date.parse('2026-09-08T12:00:00.000Z');
 const policy={schema:'relationship-artifact-policy-v1',policy_version:'synthetic-v1',expires_at:new Date(now+60000).toISOString(),bindings:[binding]};
 const state={status:'active',run,superseded_run:null,tombstone:null};
 return {run,producer,ctx,binding,policy,now,state};
}
async function harness(runOverride?:any,producer?:string){
 const f=fixture(runOverride,producer);let now=f.now,policy:any=f.policy,ctx:any=f.ctx,cohort=true,authCalls=0,automatic=false,automaticExpires=f.policy.expires_at;
 const objects=new Map<string,{body:Buffer;headers:Headers}>(),calls:any[]=[];
 let onIo:((r:any)=>void)|undefined,mutateRead:((r:any)=>void)|undefined,putStatus=200,revokeFinal=false;
 const app=Fastify({logger:false,bodyLimit:4*1024*1024});
 registerRelationshipArtifactGatewayRoutes(app,{
  authenticate:async()=>{authCalls++;return revokeFinal&&authCalls%2===0?undefined:ctx;},policyJson:()=>typeof policy==='string'?policy:canonical(policy),now:()=>now,
  resolveCohortBinding:async()=>cohort?{policy:{schema:'graph-worker-bindings-v1',expires_at:f.policy.expires_at},binding:{authenticated_caller:'cfo',run:f.run,room:'finance',source_index:'finance-cfo-source-docs'}}:null,
  resolveAutomaticBinding:async(c:any,runId:string,producerId:string)=>(automatic&&cohort&&c.caller_agent==='cfo'&&c.caller_hash===f.ctx.caller_hash&&runId===f.run.run_id&&producerId===f.producer)?{binding:f.binding,cohort_id:'synthetic-cohort',policy_version:'synthetic-publication-v1',expires_at:automaticExpires,admission:{key:`graph-trial/20260908/catalog-cohorts/synthetic-cohort/server/admissions/${f.run.run_id}.json`,version_id:'admission-v1',sha256:hash('admission')},proposal:{key:'graph-trial/20260908/catalog-cohorts/synthetic-cohort/server/proposals/'+hash('proposal')+'.json',version_id:'proposal-v1',sha256:hash('proposal')},source_policy:{catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:hash('catalog'),source_prefixes:['synthetic/']}}:null,
  s3:async(r:any)=>{calls.push(r);assert.equal(r.signal.aborted,false);
   if(r.key.includes('/active-runs/'))return{status:200,headers:new Headers({etag:'"active-v1"'}),body:Buffer.from(canonical({schema:'neptune-trial-active-run-state-v1',state_sha256:hash(canonical(f.state)),state:f.state}))};
   onIo?.(r);
   if(r.method==='PUT'){
    if(objects.has(r.key))return{status:412,headers:new Headers(),body:Buffer.from('synthetic upstream details')};
    const headers=new Headers({...r.headers,'x-amz-version-id':'synthetic+/=v1'}),saved={body:Buffer.from(r.body),headers};objects.set(r.key,saved);
    return{status:putStatus,headers,body:Buffer.alloc(0)};
   }
   const saved=objects.get(r.key);if(!saved)return{status:404,headers:new Headers(),body:Buffer.alloc(0)};
   const result={status:200,headers:new Headers(saved.headers),body:Buffer.from(saved.body)};mutateRead?.(result);return result;
  }
 });
 const pack=(payload:any)=>{const digest=hash(canonical(payload));return{url:`/relationship-artifacts/v1/${f.run.run_id}/${f.producer}/sha256/${digest.slice(0,2)}/${digest}.json`,body:{schema:'relationship-resolution-artifact-v1',payload_sha256:digest,payload}};};
 const source=(input:any={text:'synthetic full evidence'})=>pack({schema:'resolution-source-input-v1',run:f.run,input});
 const request=(p:ReturnType<typeof pack>,method:'GET'|'PUT'='PUT',extra:any={})=>app.inject({method,url:p.url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json',...(method==='PUT'?{'if-none-match':'*'}:{}),...extra.headers},...(method==='PUT'?{payload:canonical(p.body)}:{}),...Object.fromEntries(Object.entries(extra).filter(([k])=>k!=='headers'))});
 return{f,app,objects,calls,pack,source,request,setPolicy:(p:any)=>policy=p,setCtx:(c:any)=>ctx=c,setCohort:(c:boolean)=>cohort=c,setNow:(n:number)=>now=n,setAutomatic:(v:boolean)=>automatic=v,setAutomaticExpires:(v:string)=>automaticExpires=v,onIo:(fn:any)=>onIo=fn,mutateRead:(fn:any)=>mutateRead=fn,putStatus:(n:number)=>putStatus=n,revokeFinal:()=>revokeFinal=true};
}
test('immutable source and history PUT, exact opaque version GET, and duplicate recovery',async()=>{
 const t=await harness();try{for(const p of[t.source(),t.pack({schema:'resolution-history-v1',run:t.f.run,caller_seat:'cfo',sources:[],events:[],queries:[]})]){
  const put=await t.request(p);assert.equal(put.statusCode,200,put.body);assert.equal(put.headers['x-amz-version-id'],'synthetic+/=v1');
  const get=await t.request(p,'GET',{url:p.url+'?versionId='+encodeURIComponent('synthetic+/=v1')});assert.equal(get.statusCode,200,get.body);assert.deepEqual(get.json(),p.body);assert.equal(get.headers['x-amz-server-side-encryption'],'AES256');
  assert.equal((await t.request(p)).statusCode,412);assert.equal((await t.request(p,'GET')).statusCode,200);
 }assert.ok(t.calls.some(r=>r.versionId==='synthetic+/=v1'));}finally{await t.app.close();}
});
test('dark policy and wrong seat, credential, producer, or absent cohort fail before artifact IO',async()=>{
 for(const change of[(t:any)=>t.setPolicy(''),(t:any)=>t.setCtx({...t.f.ctx,caller_agent:'cto'}),(t:any)=>t.setCtx({...t.f.ctx,caller_hash:hash('other')}),(t:any)=>t.setPolicy({...t.f.policy,bindings:[{...t.f.binding,producer_id:'other'}]}),(t:any)=>t.setCohort(false)]){
  const t=await harness();try{change(t);assert.ok([403,404].includes((await t.request(t.source())).statusCode));assert.equal(t.calls.filter(r=>!r.key.includes('/active-runs/')).length,0);}finally{await t.app.close();}
 }
});
test('automatic authorization is derived per admitted CFO run and fails closed for unrelated, stale, or disabled records',async()=>{
 const t=await harness();try{
  t.setPolicy('');t.setAutomatic(true);const p=t.source();const allowed=await t.request(p);assert.equal(allowed.statusCode,200,allowed.body);
  const request={action:'write',artifact_ref:null,run:t.f.run,caller_seat:'cfo',store_id:'relationship-gateway-v1'};
  const provenance=(await t.app.inject({method:'POST',url:`/relationship-artifacts/v1/${t.f.run.run_id}/${t.f.producer}/authorize`,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(request)})).json().provenance;
  assert.equal(provenance.decision_source,'authenticated_resolution_store');assert.equal(provenance.authority_source,'automatic_catalog_publication_admission');assert.equal(provenance.authorization_basis,'catalog_publication_admission');assert.equal(provenance.authenticated_producer_id,t.f.producer);assert.equal(provenance.cohort_id,'synthetic-cohort');assert.ok(/^[a-f0-9]{64}$/.test(provenance.admission_sha256));assert.ok(/^[a-f0-9]{64}$/.test(provenance.proposal_sha256));
  const {createReviewHistoryAuthority}=await import('../../tools/relationship-artifacts/review-history-authority.mjs');
  const authority=createReviewHistoryAuthority({run:t.f.run,producer:t.f.producer,getAuthorization:async()=> 'Bearer synthetic-fixture-token-value',fetchImpl:async(url:string,init:any)=>{const response=await t.app.inject({method:init.method,url:new URL(url).pathname+new URL(url).search,headers:init.headers,payload:init.body});return new Response(response.rawPayload,{status:response.statusCode,headers:response.headers as Record<string,string>});}});
  assert.equal((await authority.authorizeHistory(request)).provenance.decision_source,'authenticated_resolution_store');
  t.setAutomatic(false);await assert.rejects(authority.authorizeHistory(request),{code:'relationship_authority_denied'});t.setAutomatic(true);
  for(const change of[(x:any)=>x.setAutomatic(false),(x:any)=>x.setCtx({...x.f.ctx,caller_hash:hash('foreign')}),(x:any)=>x.setAutomaticExpires(new Date(x.f.now-1).toISOString())]){
   const x=await harness();try{x.setPolicy('');x.setAutomatic(true);change(x);assert.equal((await x.request(x.source())).statusCode,403);}finally{await x.app.close();}
  }
  for(const staticPolicy of[' ','{']){const x=await harness();try{x.setPolicy(staticPolicy);x.setAutomatic(true);assert.equal((await x.request(x.source())).statusCode,403);}finally{await x.app.close();}}
  const foreign=`/relationship-artifacts/v1/${t.f.run.run_id}/other-producer/sha256/${p.body.payload_sha256.slice(0,2)}/${p.body.payload_sha256}.json`;assert.equal((await t.request(p,'PUT',{url:foreign})).statusCode,403);
 }finally{await t.app.close();}
});
test('publication resolver composes the active cohort, exact source policy, and immutable pins',async()=>{
 const {resolveRelationshipArtifactAutomaticBinding}=await import('./relationship-publication.js'),f=fixture(),source_policy={catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:hash('catalog'),source_prefixes:['synthetic/']},publication={schema:'relationship-publication-policy-v1',policy_version:'synthetic-publication-v1',expires_at:new Date(f.now+60000).toISOString(),bindings:[{authenticated_caller:'cfo',caller_hash:f.ctx.caller_hash,producer_id:f.producer,cohort_id:'synthetic-cohort',purpose:f.run.purpose,run_version:f.run.run_version,encryption:{algorithm:'AES256'},source_policy}]};
 const admission={key:`graph-trial/20260908/catalog-cohorts/synthetic-cohort/server/admissions/${f.run.run_id}.json`,version_id:'admission-v1',sha256:hash('admission')},proposal={key:'graph-trial/20260908/catalog-cohorts/synthetic-cohort/server/proposals/'+hash('proposal')+'.json',version_id:'proposal-v1',sha256:hash('proposal')},calls:any[]=[];
 const deps:any={policyJson:()=>canonical(publication),now:()=>f.now,resolveCatalogCohortBinding:async(...args:any[])=>{calls.push(args);return{cohort_id:'synthetic-cohort',source_policy,binding:{authenticated_caller:'cfo',run:f.run,room:'finance',source_index:'finance-cfo-source-docs'}};},resolveRelationshipPublicationAdmission:async(input:any)=>{calls.push(input);return{admission,proposal};}};
 const got=await resolveRelationshipArtifactAutomaticBinding({run_id:f.run.run_id,producer_id:f.producer,ctx:f.ctx,signal:new AbortController().signal},deps);assert.deepEqual(got?.admission,admission);assert.deepEqual(got?.proposal,proposal);assert.equal(calls[1].cohortId,'synthetic-cohort');
 const changed=structuredClone(publication);changed.bindings[0].source_policy={...source_policy,catalog_source_sha256:hash('other')};assert.equal(await resolveRelationshipArtifactAutomaticBinding({run_id:f.run.run_id,producer_id:f.producer,ctx:f.ctx,signal:new AbortController().signal},{...deps,policyJson:()=>canonical(changed)}),null);
});
test('conditional write, envelope identity, scope and query tampering are refused',async()=>{
 const t=await harness();try{const p=t.source();
  for(const extra of[{headers:{'if-none-match':''}},{headers:{'if-match':'"v1"'}},{url:p.url+'?versionId=v1'},{payload:canonical({...p.body,payload_sha256:hash('wrong')})}])assert.ok([400,401].includes((await t.request(p,'PUT',extra)).statusCode));
  assert.equal((await t.request(t.pack({schema:'resolution-source-input-v1',run:{...t.f.run,scope:'legal'},input:{}}))).statusCode,400);
  assert.equal((await t.request(t.pack({schema:'resolution-history-v1',run:t.f.run,caller_seat:'clo',sources:[],events:[],queries:[]}))).statusCode,400);
  for(const query of['?versionId=null','?versionId=a&versionId=b','?arbitrary=x','?versionId='])assert.equal((await t.request(p,'GET',{url:p.url+query})).statusCode,400);
  assert.equal(t.objects.size,0);
 }finally{await t.app.close();}
});
test('policy, admission and credential revocation during IO withhold success and bodies',async()=>{
 for(const change of[(t:any)=>t.setPolicy(''),(t:any)=>t.setCohort(false),(t:any)=>t.setNow(t.f.now+60001),(t:any)=>t.revokeFinal(),(t:any)=>{t.f.state.status='retired';}]){
  const t=await harness();try{t.onIo(()=>change(t));const result=await t.request(t.source());assert.equal(result.statusCode,403,result.body);assert.equal(result.body,'');}finally{await t.app.close();}
 }
});
test('corrupt, unversioned, wrong-version and wrong-encryption stored objects fail closed',async()=>{
 for(const change of[(r:any)=>r.headers.set('x-amz-version-id','null'),(r:any)=>r.headers.set('x-amz-version-id','other'),(r:any)=>r.headers.set('x-amz-server-side-encryption','other'),(r:any)=>r.headers.set('x-amz-meta-resolution-producer','other'),(r:any)=>r.body=Buffer.from('{}')]){
  const t=await harness();try{const p=t.source();assert.equal((await t.request(p)).statusCode,200);t.mutateRead(change);const result=await t.request(p,'GET',{url:p.url+'?versionId='+encodeURIComponent('synthetic+/=v1')});assert.equal(result.statusCode,503,result.body);assert.equal(result.body,'');}finally{await t.app.close();}
 }
});
test('16 MiB payload is accepted above ordinary server limit and larger payload refused',async()=>{
 const t=await harness();try{const empty=t.source({text:''});const padding=16*1024*1024-Buffer.byteLength(canonical(empty.body.payload));const exact=t.source({text:'x'.repeat(padding)});assert.equal((await t.request(exact)).statusCode,200);const large=t.source({text:'x'.repeat(padding+1)});assert.ok([400,413].includes((await t.request(large)).statusCode));}finally{await t.app.close();}
});
test('deep JSON is refused and upstream failed-write result stays uncertain without details',async()=>{
 const t=await harness();try{let nested:any={};for(let i=0;i<140;i++)nested={nested};assert.equal((await t.request(t.source(nested))).statusCode,400);t.putStatus(503);const p=t.source();const r=await t.request(p);assert.equal(r.statusCode,503);assert.equal(r.body,'');assert.equal((await t.request(p,'GET')).statusCode,200);}finally{await t.app.close();}
});
test('KMS response headers remain available and read-time revocation withholds saved evidence',async()=>{
 const t=await harness();try{
  t.setPolicy({...t.f.policy,bindings:[{...t.f.binding,encryption:{algorithm:'aws:kms',kms_key_id:'synthetic-kms-key-id'}}]});
  const p=t.source();const put=await t.request(p);assert.equal(put.statusCode,200);assert.equal(put.headers['x-amz-server-side-encryption-aws-kms-key-id'],'synthetic-kms-key-id');
  const get=await t.request(p,'GET');assert.equal(get.statusCode,200);assert.equal(get.headers['x-amz-server-side-encryption-aws-kms-key-id'],'synthetic-kms-key-id');
  t.onIo(()=>t.setPolicy(''));const denied=await t.request(p,'GET');assert.equal(denied.statusCode,403);assert.equal(denied.body,'');
 }finally{await t.app.close();}
});
test('unversioned discovery cannot turn an S3 null version into an immutable reference',async()=>{
 const t=await harness();try{const p=t.source();assert.equal((await t.request(p)).statusCode,200);t.mutateRead((r:any)=>r.headers.set('x-amz-version-id','null'));assert.equal((await t.request(p,'GET')).statusCode,503);}finally{await t.app.close();}
});
test('authorization preflight emits only a guarded authenticated-resolution-store decision',async()=>{
  const t=await harness();try{const request=(action:'write'|'read',artifact_ref:any=null,extra:any={})=>({action,artifact_ref,run:t.f.run,caller_seat:'cfo',store_id:'relationship-gateway-v1',...extra});const url=`/relationship-artifacts/v1/${t.f.run.run_id}/${t.f.producer}/authorize`;
   const write=await t.app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(request('write'))});assert.equal(write.statusCode,200);assert.deepEqual(write.json().provenance,{decision_source:'authenticated_resolution_store',authority_source:'relationship_artifact_policy',authorization_basis:'static_policy_binding',policy_version:'synthetic-v1',authenticated_store_id:'relationship-gateway-v1',authenticated_producer_id:t.f.producer,allowed_roles:['cfo']});assert.equal(write.json().authorization_request_sha256,hash(canonical(request('write'))));
  for(const bad of[request('write',null,{store_id:'other'}),request('write',t.source().body)])assert.equal((await t.app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(bad)})).statusCode,400);
  assert.equal((await t.app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(request('write',null,{caller_seat:'clo'}))})).statusCode,403);
  const p=t.source();assert.equal((await t.request(p)).statusCode,200);const ref={schema:'relationship-resolution-artifact-ref-v1',artifact_id:'resart_'+p.body.payload_sha256,bucket:'otchealth-finance-legal-dr-55c84f6b',key:`resolution-artifacts/sha256/${p.body.payload_sha256.slice(0,2)}/${p.body.payload_sha256}.json`,payload_sha256:p.body.payload_sha256,version_id:'synthetic+/=v1',size_bytes:Buffer.byteLength(canonical(p.body.payload))};assert.equal((await t.app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(request('read',ref))})).statusCode,200);t.setCohort(false);assert.equal((await t.app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(request('write'))})).statusCode,403);
 }finally{await t.app.close();}
});
test('artifact storage authorization preflight binds get and put to the exact route scope and stored version',async()=>{
 const t=await harness();try{const url=`/relationship-artifacts/v1/${t.f.run.run_id}/${t.f.producer}/authorize`,scope={run:t.f.run,caller_seat:'cfo',producer_id:t.f.producer},p=t.source(),base=(action:'put'|'get',extra:any={})=>({action,scope,artifact_id:'resart_'+p.body.payload_sha256,sha256:p.body.payload_sha256,...extra}),post=(body:any)=>t.app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-fixture','content-type':'application/json'},payload:canonical(body)});
  assert.equal((await post(base('put'))).statusCode,200);assert.equal((await post(base('get',{version_id:'synthetic+/=v1'}))).statusCode,403);assert.equal((await t.request(p)).statusCode,200);assert.equal((await post(base('get',{version_id:'synthetic+/=v1'}))).statusCode,200);
  for(const bad of[{...base('put'),action:'write'},{...base('put'),sha256:'c'.repeat(64)},{...base('get',{version_id:'null'})},{...base('put'),scope:{...scope,producer_id:'other'}}])assert.equal((await post(bad)).statusCode,400);
 }finally{await t.app.close();}
});
test('actual CTO store crosses gateway mapping for KMS, conflict and lost-write recovery', {skip:!process.env.RELATIONSHIP_STORE_MODULE}, async()=>{
 const {createS3ResolutionStore}=await import(pathToFileURL(process.env.RELATIONSHIP_STORE_MODULE!).href);
 const {createGatewayRelationshipStore}=await import('../../tools/relationship-artifacts/gateway-store.mjs');
 for(const sse of[{algorithm:'AES256'},{algorithm:'aws:kms',kmsKeyId:'synthetic-kms-key-id'}]){
  const t=await harness();try{
   t.setPolicy({...t.f.policy,bindings:[{...t.f.binding,encryption:sse.algorithm==='AES256'?{algorithm:'AES256'}:{algorithm:'aws:kms',kms_key_id:sse.kmsKeyId}}]});
   let wireCalls=0;
   const store=createGatewayRelationshipStore({createS3ResolutionStore,gatewayOrigin:'https://synthetic-gateway.invalid',run:t.f.run,producer:t.f.producer,sse,historyTrust:{store_id:'synthetic-store',producer_ids:[t.f.producer]},
    authorizeArtifact:async(request:any)=>{assert.equal(request.scope.producer_id,t.f.producer);assert.deepEqual(request.scope.run,t.f.run);return{allowed:true};},
    getAuthorization:async()=> 'Bearer synthetic-fixture-token-value',
    fetchImpl:async(url:string,init:any)=>{wireCalls++;assert.equal(new URL(url).origin,'https://synthetic-gateway.invalid');assert.equal(init.redirect,'error');
     const response=await t.app.inject({method:init.method,url:new URL(url).pathname+new URL(url).search,headers:init.headers,...(init.body===undefined?{}:{payload:init.body})});
     return new Response(response.rawPayload,{status:response.statusCode,headers:response.headers as Record<string,string>});
    }});
   const scope={run_id:t.f.run.run_id,caller_seat:'cfo'},payload=t.source().body.payload;
   const ref=await store.putArtifact(payload,{scope});assert.equal(ref.version_id,'synthetic+/=v1');assert.deepEqual(await store.getArtifact(ref,{scope}),payload);
   assert.deepEqual(await store.putArtifact(payload,{scope}),ref);
   t.putStatus(503);const lost=t.source({text:'synthetic persisted write with missing acknowledgement'}).body.payload;
   const recovered=await store.putArtifact(lost,{scope});assert.deepEqual(await store.getArtifact(recovered,{scope}),lost);
   const before=wireCalls;await assert.rejects(store.getArtifact(ref,{scope:{run_id:t.f.run.run_id,caller_seat:'clo'}}));assert.equal(wireCalls,before);
   assert.ok(t.calls.filter(r=>r.method==='GET'&&r.versionId==='synthetic+/=v1').length>=5);
  }finally{await t.app.close();}
 }
});
test('actual durable review and reconstructed retrieval retain original decisions through gateway', {skip:!process.env.RELATIONSHIP_STORE_MODULE},async()=>{
 const moduleUrl=pathToFileURL(process.env.RELATIONSHIP_STORE_MODULE!);
 const {createS3ResolutionStore}=await import(moduleUrl.href);
 const {createDurableResolution}=await import(new URL('./durable-resolution.mjs',moduleUrl).href);
 const {createSyntheticWire}=await import(new URL('./synthetic-wire-fixture.mjs',moduleUrl).href);
 const {createGatewayRelationshipStore}=await import('../../tools/relationship-artifacts/gateway-store.mjs');
 const f=createSyntheticWire(),t=await harness(f.state.run,'synthetic-reviewer-1');
 const {createReviewHistoryAuthority}=await import('../../tools/relationship-artifacts/review-history-authority.mjs');
 const transport=async(url:string,init:any)=>{const response=await t.app.inject({method:init.method,url:new URL(url).pathname+new URL(url).search,headers:init.headers,...(init.body===undefined?{}:{payload:init.body})});return new Response(response.rawPayload,{status:response.statusCode,headers:response.headers as Record<string,string>});};
 const authority=createReviewHistoryAuthority({run:f.state.run,producer:t.f.producer,getAuthorization:async()=> 'Bearer synthetic-fixture-token-value',fetchImpl:transport});
 f.options.historyTrust={store_id:'relationship-gateway-v1',producer_ids:[t.f.producer]};f.options.authorizeHistory=authority.authorizeHistory;
 try{
  const store=createGatewayRelationshipStore({createS3ResolutionStore,gatewayOrigin:'https://synthetic-gateway.invalid',run:f.state.run,producer:t.f.producer,sse:{algorithm:'AES256'},historyTrust:f.options.historyTrust,
   authorizeArtifact:authority.authorizeArtifact,getAuthorization:async()=> 'Bearer synthetic-fixture-token-value',
   fetchImpl:async(url:string,init:any)=>{const response=await t.app.inject({method:init.method,url:new URL(url).pathname+new URL(url).search,headers:init.headers,...(init.body===undefined?{}:{payload:init.body})});return new Response(response.rawPayload,{status:response.statusCode,headers:response.headers as Record<string,string>});}});
  const workflow=createDurableResolution({...f.options,store,historyTrust:store.boundHistoryTrust}),batch=f.batch({withCorrection:true}),receipt=await workflow.review(batch);
  assert.equal(receipt.results[0].status,'qualified');const priorVerifiers=f.counters.verifiers;
  const restored=createDurableResolution({...f.options,store,historyTrust:store.boundHistoryTrust,verifiers:null}),retrieved=await restored.retrieve(receipt.artifact_ref,batch.queries[0]);
  assert.equal(retrieved.answer.status,'qualified');assert.deepEqual(retrieved.answer.evidence,receipt.results[0].evidence);assert.equal(f.counters.verifiers,priorVerifiers);
  f.state.changed=['payment'];assert.equal((await restored.retrieve(receipt.artifact_ref,{...batch.queries[0],premise_ids:receipt.results[0].premise_ids})).answer.status,'invalidated');
  t.setCohort(false);await assert.rejects(restored.retrieve(receipt.artifact_ref,batch.queries[0]));
 }finally{await t.app.close();}
});
