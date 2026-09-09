import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
Object.assign(process.env,{CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-fixture-only-not-real-000001',ADMIN_REVOKE_TOKEN:'synthetic-fixture-only-not-real-000002',N8N_WEBHOOK_SECRET:'synthetic-fixture-only-not-real-000003'});
const {registerGraphCatalogControllerRoutes,resolveCatalogCohortBinding,graphCatalogControllerTest:internals}=await import('./graph-catalog-controller.js');
import { planGraphCatalogPage } from './graph-catalog-planner.js';
import { verifyMaterializationReceipt } from './materialized-catalog-pin.js';
const {canonical,hash}=internals;
const ctx={caller_agent:'cfo',caller_hash:'synthetic',raw_token:'synthetic-fixture',connector_surface:true,m365_static_auth:false} as any;
async function harness(){
 const objects=new Map<string,{body:Buffer;etag:string}>();let revision=0,calls=0,failActivation=false,now=Date.now();
 const cfg={cohort_id:'synthetic',catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:hash('synthetic catalog'),source_prefixes:['synthetic/'],purpose:'company_graph_backfill',run_version:'test-v1',batch_size:2,max_admissions:2,policy_sha256:hash('synthetic policy'),expires_at:new Date(now+3600000).toISOString(),recovery_policy_sha256:hash('synthetic recovery'),recovery_expires_at:new Date(now+7200000).toISOString()};
 let configs:any[]=[cfg];const rows=['a','b','c'].map(x=>({path:`synthetic/${x}.txt`,sha256:hash(x),sidecar:true,enriched:true,enriched_sha256:hash(x),entity:'Synthetic'}));
 const text=rows.map(canonical).join('\n')+'\n',createdAt='2026-09-08T00:00:00.000Z';
 const catalog={rows,catalogEtag:'"catalog-v1"',catalogSourceSha256:cfg.catalog_source_sha256,createdAt};
 const deps={configs:()=>canonical(configs),now:()=>now,authenticate:async(r:any)=>({...ctx,caller_agent:r.headers.authorization==='Bearer synthetic-cfo-token'?'cfo':'cto'}),
  catalogS3:async(r:any)=>{calls++;assert.equal(r.key,cfg.catalog_key);if(r.method==='GET')assert.equal(r.headers['if-match'],catalog.catalogEtag);return{status:200,headers:new Headers({etag:catalog.catalogEtag,'content-length':String(Buffer.byteLength(text)),'last-modified':createdAt}),body:r.method==='HEAD'?null:new Response(text).body};},
  s3:async(r:any)=>{calls++;const old=objects.get(r.key);if(r.method==='GET')return{status:old?200:404,headers:new Headers(old?{etag:old.etag}:{}),body:old?.body??Buffer.alloc(0)};
   const heads=new Headers(r.headers);if(heads.get('if-none-match')==='*'&&old||heads.has('if-match')&&heads.get('if-match')!==old?.etag)return{status:412,headers:new Headers(),body:Buffer.alloc(0)};
   if(failActivation&&r.key.endsWith('/server/control.json')&&JSON.parse(r.body.toString()).current.status==='active'){failActivation=false;return{status:503,headers:new Headers(),body:Buffer.alloc(0)};}
   const saved={body:Buffer.from(r.body),etag:`"${++revision}"`};objects.set(r.key,saved);return{status:200,headers:new Headers({etag:saved.etag}),body:Buffer.alloc(0)};
  }};
 const app=Fastify({logger:false});registerGraphCatalogControllerRoutes(app,deps);
 const request=async(path:string,value?:unknown,method?:string,token='synthetic-cfo-token')=>app.inject({method:(method??(value===undefined?'GET':'POST')) as any,url:'/graph-catalog/v1/synthetic'+path,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value===undefined?{}:{payload:JSON.stringify(value)})});
 const publish=async(n=0)=>{const page=planGraphCatalogPage({...catalog,rows:[rows[n]],limit:1}).page;const r=await request('/publish',{manifest:page.manifest,rows:page.rows});assert.equal(r.statusCode,200,r.body);return internals.proposal(cfg,catalog,page.manifest);};
 return{app,deps,cfg,objects,request,publish,get calls(){return calls;},setConfigs:(v:any[])=>{configs=v;},failActivation:()=>{failActivation=true;},expire:()=>{now+=3600001;}};
}
test('default registration is offline and absent or malformed cohorts never read S3',async()=>{const app=Fastify();assert.doesNotThrow(()=>registerGraphCatalogControllerRoutes(app));await app.close();const h=await harness();try{h.setConfigs([]);assert.equal((await h.request('/config')).statusCode,404);assert.equal(h.calls,0);h.setConfigs([{...h.cfg,source_prefixes:['../']}]);assert.equal((await h.request('/config')).statusCode,404);assert.equal(h.calls,0);h.setConfigs([h.cfg]);assert.equal((await h.request('/page',{cursor:null,limit:1},'POST','synthetic-cto-token')).statusCode,403);assert.equal(h.calls,0);}finally{await h.app.close();}});
test('immutable publication and ETag state reject forged proposals and authority paths',async()=>{const h=await harness();try{const p=await h.publish();const value={schema:'catalog-controller-version-v1',proposal:p,status:'prepared',outcome:null,chunks:[],preparation:null};const key=`versions/${p.key}`;
 assert.equal((await h.request('/state/server/control',{key:'server/control',revision:null,value},'PUT')).statusCode,400);
 assert.equal((await h.request('/state/'+key,{key,revision:null,value:{...value,proposal:{...p,max_documents:2}}},'PUT')).statusCode,400);
 const first=await h.request('/state/'+key,{key,revision:null,value},'PUT');assert.equal(first.statusCode,200,first.body);const revision=first.json().revision;
 const dispatched=await h.request('/state/'+key,{key,revision,value:{...value,status:'dispatching'}},'PUT');assert.equal(dispatched.statusCode,200,dispatched.body);
 assert.equal((await h.request('/state/'+key,{key,revision:dispatched.json().revision,value},'PUT')).statusCode,409);
 assert.equal((await h.request('/state/'+key,{key,revision:dispatched.json().revision,value:{...value,status:'complete'}},'PUT')).statusCode,400);
 }finally{await h.app.close();}});
test('reservation consumes budget before authority and lost activation remains inactive until exact retry',async()=>{const h=await harness();try{const p=await h.publish();h.failActivation();const first=await h.request('/admit',{key:p.key,manifest_sha256:p.manifest.manifest_sha256});assert.equal(first.statusCode,503,first.body);
 assert.equal(await resolveCatalogCohortBinding(ctx,p.run.run_id,AbortSignal.timeout(5000),h.deps),null);
 const ctl=()=>JSON.parse(h.objects.get(`${internals.BASE}/synthetic/server/control.json`)!.body.toString());assert.equal(ctl().used,1);assert.equal(ctl().current.status,'reserved');
 const retried=await h.request('/admit',{key:p.key,manifest_sha256:p.manifest.manifest_sha256});assert.equal(retried.statusCode,200,retried.body);assert.equal(ctl().used,1);
 assert.ok(await resolveCatalogCohortBinding(ctx,p.run.run_id,AbortSignal.timeout(5000),h.deps));
 assert.deepEqual((await h.request('/admit',{key:p.key,manifest_sha256:p.manifest.manifest_sha256})).json(),retried.json());
 const next=await h.publish(1);assert.equal((await h.request('/admit',{key:next.key,manifest_sha256:next.manifest.manifest_sha256})).statusCode,409);assert.equal(ctl().used,1);
 h.expire();assert.equal(await resolveCatalogCohortBinding(ctx,p.run.run_id,AbortSignal.timeout(5000),h.deps),null);assert.equal((await h.request('/recovery',{key:p.key,run_id:p.run.run_id})).statusCode,200);assert.equal((await h.request('/page',{cursor:null,limit:1})).statusCode,403);
 }finally{await h.app.close();}});



async function materializedHarness(){
 const objects=new Map<string,{body:Buffer;etag:string}>();let revision=0,sourceVersion='source-v1',sourceHeads=0,now=Date.now();
 const prefixes=['synthetic/'],sourceCatalogVersion='source-v1',catalogText=[{path:'synthetic/a.txt',sha256:hash('a'),sidecar:true,enriched:true,enriched_sha256:hash('a'),entity:'Synthetic'}].map(canonical).join('\n')+'\n';
 let catalogBody=catalogText;const logical=hash(canonical({room:'finance',source_index:'finance-cfo-source-docs',url:'https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl'}));
 const content=hash(catalogText),binding:any={schema:'cfo-catalog-materialization-v1',cohort_id:'materialized',policy_sha256:hash('materialized policy'),source_prefixes_sha256:hash(canonical(prefixes)),source_version_id:sourceCatalogVersion,source_etag_sha256:hash('source etag'),source_catalog_content_sha256:hash('source bytes'),source_bytes:12,catalog_content_sha256:content,catalog_source_sha256:logical,catalog_bytes:Buffer.byteLength(catalogText),counts:{source_rows:1,eligible_rows:1,duplicate_rows:0,excluded:{}},lineage:'catalog_association_only',source_current_checked:true};
 const binding_sha256=hash(canonical(binding)),catalog_key=`graph-trial/20260909/materialized-cfo/materialized/${binding_sha256}/${content}.jsonl`,receipt={...binding,status:'published',published:true,catalog_key,catalog_version_id:'catalog-v1',binding_sha256},receiptBody=Buffer.from(canonical(receipt)),receiptKey=catalog_key.replace(/\.jsonl$/,'.receipt.json');
 const cfg={cohort_id:'materialized',catalog_key,catalog_source_sha256:logical,source_prefixes:prefixes,purpose:'company_graph_backfill',run_version:'test-v1',batch_size:2,max_admissions:2,policy_sha256:binding.policy_sha256,expires_at:new Date(now+3600000).toISOString(),materialization:{catalog_content_sha256:content,source_catalog_version_id:sourceCatalogVersion,materialization_receipt_key:receiptKey,materialization_receipt_sha256:hash(receiptBody),catalog_version_id:'catalog-v1'}};
 const deps:any={configs:()=>canonical([cfg]),now:()=>now,authenticate:async()=>ctx,sourceHead:async()=>{sourceHeads++;return{status:200,headers:new Headers({'x-amz-version-id':sourceVersion}),body:Buffer.alloc(0)}},catalogS3:async(r:any)=>({status:200,headers:new Headers({etag:'"catalog-v1"','content-length':String(Buffer.byteLength(catalogBody)),'last-modified':'2026-09-08T00:00:00.000Z','x-amz-version-id':'catalog-v1'}),body:r.method==='HEAD'?null:new Response(catalogBody).body}),s3:async(r:any)=>{if(r.method==='GET'&&r.key===receiptKey)return{status:200,headers:new Headers({'x-amz-version-id':'receipt-v1'}),body:receiptBody};const prior=objects.get(r.key);if(r.method==='GET')return{status:prior?200:404,headers:new Headers(prior?{etag:prior.etag}:{}),body:prior?.body??Buffer.alloc(0)};const saved={body:Buffer.from(r.body),etag:`"${++revision}"`};objects.set(r.key,saved);return{status:200,headers:new Headers({etag:saved.etag}),body:Buffer.alloc(0)}}};
 const app=Fastify({logger:false});registerGraphCatalogControllerRoutes(app,deps);const request=(path:string,value?:unknown)=>app.inject({method:'POST',url:'/graph-catalog/v1/materialized'+path,headers:{authorization:'Bearer synthetic-cfo-token','content-type':'application/json'},payload:JSON.stringify(value)});
 return{app,request,cfg,receiptBody,receiptKey,setSourceVersion:(v:string)=>{sourceVersion=v;},setCatalogText:()=>{catalogBody=catalogBody.replace('Synthetic','SynthEtic');},get sourceHeads(){return sourceHeads;}};
}
test('materialized routes reject an altered catalog before planner output and preserve legacy route behavior',async()=>{const h=await materializedHarness();try{await assert.doesNotReject(verifyMaterializationReceipt({...h.cfg,materialization:h.cfg.materialization},async()=>({status:200,headers:new Headers({'x-amz-version-id':'receipt-v1'}),body:h.receiptBody}),AbortSignal.timeout(1000)));assert.ok(internals.configFor(canonical([h.cfg]),'materialized'));h.setCatalogText();const r=await h.request('/page',{cursor:null,limit:1});assert.equal(r.statusCode,503,r.body);assert.equal(h.sourceHeads,1);}finally{await h.app.close();}});
test('materialized publish, current retrieval, and repeat admission reject a changed upstream source version',async()=>{const h=await materializedHarness();try{const page=await h.request('/page',{cursor:null,limit:1});assert.equal(page.statusCode,200,page.body);const manifest=page.json().page.manifest,rows=page.json().page.rows;const published=await h.request('/publish',{manifest,rows});assert.equal(published.statusCode,200,published.body);const proposal=internals.proposal(h.cfg,{catalogEtag:'"catalog-v1"',catalogSourceSha256:h.cfg.catalog_source_sha256,createdAt:'2026-09-08T00:00:00.000Z'},manifest);const first=await h.request('/admit',{key:proposal.key,manifest_sha256:manifest.manifest_sha256});assert.equal(first.statusCode,200,first.body);h.setSourceVersion('source-v2');const current=await h.request('/source-current',{item:manifest.documents[0]});assert.equal(current.statusCode,409,current.body);const repeated=await h.request('/admit',{key:proposal.key,manifest_sha256:manifest.manifest_sha256});assert.equal(repeated.statusCode,409,repeated.body);}finally{await h.app.close();}});




