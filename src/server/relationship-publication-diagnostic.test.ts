import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';

for(const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'}))process.env[key]??=value;
const { registerRelationshipPublicationRoutes }=await import('./relationship-publication.js');

const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value as Record<string,unknown>).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const core={ref_version:'neptune-trial-active-run-ref-v1',purpose:'synthetic-publication',scope:'finance',run_version:'synthetic-v1',manifest_sha256:'a'.repeat(64)};
const run={...core,run_id:'run_'+hash(canonical(core))};
const artifact_ref={schema:'relationship-resolution-artifact-ref-v1',artifact_id:'resart_'+'b'.repeat(64),bucket:'otchealth-finance-legal-dr-55c84f6b',key:'resolution-artifacts/sha256/bb/'+'b'.repeat(64)+'.json',payload_sha256:'b'.repeat(64),version_id:'synthetic-v1',size_bytes:1};
const caller_hash='c'.repeat(64),cohort='synthetic-cohort',producer='synthetic-producer';
const policy=JSON.stringify({schema:'relationship-publication-policy-v1',policy_version:'synthetic-policy',expires_at:'2027-01-01T00:00:00.000Z',bindings:[{authenticated_caller:'cfo',caller_hash,producer_id:producer,cohort_id:cohort,purpose:run.purpose,run_version:run.run_version,encryption:{algorithm:'AES256'},source_policy:{catalog_key:'graph-trial/synthetic/catalog.jsonl',catalog_source_sha256:'d'.repeat(64),source_prefixes:['synthetic/']}}]});

async function appFor(error:Error,authenticated=true){
 const app=Fastify();
 registerRelationshipPublicationRoutes(app,{authenticate:async()=>authenticated?{caller_agent:'cfo',caller_hash,raw_token:'synthetic-token',connector_surface:true,m365_static_auth:false}:undefined,now:()=>Date.parse('2026-09-11T00:00:00.000Z'),policyJson:()=>policy,storeFor:()=>({get:async()=>{throw error;},putCreateOnly:async()=>assert.fail('unexpected put'),list:async()=>assert.fail('unexpected list')}),resolveAdmission:async()=>assert.fail('unexpected admission'),readVersion:async()=>assert.fail('unexpected artifact read')});
 await app.ready();return app;
}

test('publication diagnostics expose only allowlisted failure metadata after authenticated binding',async()=>{
 const secret='sensitive-upstream-detail-must-not-leave-the-server';
 const error=Object.assign(Error(secret),{code:'not-an-allowlisted-code',publicationStoreError:true,upstreamStatus:403});
 const app=await appFor(error);
 const response=await app.inject({method:'POST',url:`/relationship-publications/v1/${cohort}/${producer}`,headers:{authorization:'Bearer synthetic','content-type':'application/json'},payload:{run,artifact_ref}});
 assert.equal(response.statusCode,503);
 assert.equal(response.headers['x-relationship-failure-stage'],'store_get');
 assert.equal(response.headers['x-relationship-failure-code'],'unknown');
 assert.equal(response.headers['x-relationship-failure-upstream-status'],'403');
 assert.equal(response.body.includes(secret),false);
 await app.close();
});

test('publication diagnostics stay absent before authentication and policy binding',async()=>{
 const app=await appFor(Error('sensitive-upstream-detail-must-not-leave-the-server'),false);
 const response=await app.inject({method:'POST',url:`/relationship-publications/v1/${cohort}/${producer}`,headers:{authorization:'Bearer synthetic','content-type':'application/json'},payload:{run,artifact_ref}});
 assert.equal(response.statusCode,403);
 assert.equal(response.headers['x-relationship-failure-stage'],undefined);
 assert.equal(response.headers['x-relationship-failure-code'],undefined);
 assert.equal(response.headers['x-relationship-failure-upstream-status'],undefined);
 await app.close();
});
