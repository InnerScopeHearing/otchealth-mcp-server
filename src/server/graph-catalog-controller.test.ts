import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
Object.assign(process.env,{CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-fixture-only-not-real-000001',ADMIN_REVOKE_TOKEN:'synthetic-fixture-only-not-real-000002',N8N_WEBHOOK_SECRET:'synthetic-fixture-only-not-real-000003'});
const {registerGraphCatalogControllerRoutes,resolveCatalogCohortBinding,graphCatalogControllerTest:internals}=await import('./graph-catalog-controller.js');
import { planGraphCatalogPage } from './graph-catalog-planner.js';
const {canonical,hash}=internals;
const ctx={caller_agent:'cfo',caller_hash:'synthetic',raw_token:'synthetic-fixture',connector_surface:true,m365_static_auth:false} as any;
async function harness(){
 const objects=new Map<string,{body:Buffer;etag:string}>();let revision=0,calls=0,authCalls=0,failActivation=false,now=Date.now();
 const cfg={cohort_id:'synthetic',catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:hash('synthetic catalog'),source_prefixes:['synthetic/'],purpose:'company_graph_backfill',run_version:'test-v1',batch_size:2,max_admissions:2,policy_sha256:hash('synthetic policy'),expires_at:new Date(now+3600000).toISOString(),recovery_policy_sha256:hash('synthetic recovery'),recovery_expires_at:new Date(now+7200000).toISOString()};
 let configs:any[]=[cfg];const rows=['a','b','c'].map(x=>({path:`synthetic/${x}.txt`,sha256:hash(x),sidecar:true,enriched:true,enriched_sha256:hash(x),entity:'Synthetic'}));
 const text=rows.map(canonical).join('\n')+'\n',createdAt='2026-09-08T00:00:00.000Z';
 const catalog={rows,catalogEtag:'"catalog-v1"',catalogSourceSha256:cfg.catalog_source_sha256,createdAt};
 const deps={configs:()=>canonical(configs),now:()=>now,authenticate:async(r:any)=>{authCalls++;return{...ctx,caller_agent:r.headers.authorization==='Bearer synthetic-cfo-token'?'cfo':'cto'};},
  catalogS3:async(r:any)=>{calls++;assert.equal(r.key,cfg.catalog_key);if(r.method==='GET')assert.equal(r.headers['if-match'],catalog.catalogEtag);return{status:200,headers:new Headers({etag:catalog.catalogEtag,'content-length':String(Buffer.byteLength(text)),'last-modified':createdAt}),body:r.method==='HEAD'?null:new Response(text).body};},
  s3:async(r:any)=>{calls++;const old=objects.get(r.key);if(r.method==='GET')return{status:old?200:404,headers:new Headers(old?{etag:old.etag}:{}),body:old?.body??Buffer.alloc(0)};
   const heads=new Headers(r.headers);if(heads.get('if-none-match')==='*'&&old||heads.has('if-match')&&heads.get('if-match')!==old?.etag)return{status:412,headers:new Headers(),body:Buffer.alloc(0)};
   if(failActivation&&r.key.endsWith('/server/control.json')&&JSON.parse(r.body.toString()).current.status==='active'){failActivation=false;return{status:503,headers:new Headers(),body:Buffer.alloc(0)};}
   const saved={body:Buffer.from(r.body),etag:`"${++revision}"`};objects.set(r.key,saved);return{status:200,headers:new Headers({etag:saved.etag}),body:Buffer.alloc(0)};
  }};
 const app=Fastify({logger:false});registerGraphCatalogControllerRoutes(app,deps);
 const request=async(path:string,value?:unknown,method?:string,token='synthetic-cfo-token')=>app.inject({method:(method??(value===undefined?'GET':'POST')) as any,url:'/graph-catalog/v1/synthetic'+path,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value===undefined?{}:{payload:canonical(value)})});
 const publish=async(n=0)=>{const page=planGraphCatalogPage({...catalog,rows:[rows[n]],limit:1}).page;const r=await request('/publish',{manifest:page.manifest,rows:page.rows});assert.equal(r.statusCode,200,r.body);return internals.proposal(cfg,catalog,page.manifest);};
 return{app,deps,cfg,objects,request,publish,get calls(){return calls;},get authCalls(){return authCalls;},setConfigs:(v:any[])=>{configs=v;},failActivation:()=>{failActivation=true;},expire:()=>{now+=3600001;}};
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



test('cached catalog rows never bypass fresh caller authorization',async()=>{const h=await harness();try{
 const allowed=await h.request('/page',{cursor:null,limit:1},'POST','synthetic-cfo-token');assert.equal(allowed.statusCode,200,allowed.body);const calls=h.calls;
 const denied=await h.request('/page',{cursor:null,limit:1},'POST','synthetic-cto-token');assert.equal(denied.statusCode,403,denied.body);
 assert.equal(h.authCalls,2);assert.equal(h.calls,calls,'denied caller must not reach fresh HEAD or cached catalog rows');
 h.setConfigs([]);const disabled=await h.request('/page',{cursor:null,limit:1},'POST','synthetic-cfo-token');assert.equal(disabled.statusCode,404,disabled.body);
 assert.equal(h.authCalls,3);assert.equal(h.calls,calls,'disabled cohort must not reach fresh HEAD or cached catalog rows');
}finally{await h.app.close();}});
