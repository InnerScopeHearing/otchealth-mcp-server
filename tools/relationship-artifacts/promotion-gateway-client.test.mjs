import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createPromotionGatewayClient} from './promotion-gateway-client.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const runCore={ref_version:'neptune-trial-active-run-ref-v1',purpose:'promotion',scope:'finance',run_version:'v1',manifest_sha256:'b'.repeat(64)};
const run={...runCore,run_id:'run_'+createHash('sha256').update(canonical(runCore)).digest('hex')};
const source={source_document_version:'docv-synthetic',catalog_source_sha256:'d'.repeat(64),chunk_sha256:'c'.repeat(64)};
const prepared={schema:'cfo-prepared-chunk-binding-v1',run_id:run.run_id,room:'finance',source_index:'finance-cfo-source-docs',catalog_manifest_sha256:run.manifest_sha256,document_ordinal:0,source_document_version:source.source_document_version,catalog_source_sha256:'d'.repeat(64),snapshot_id:'txtsnap_'+'e'.repeat(64),prepared_manifest_sha256:'f'.repeat(64),sidecar_content_sha256:'1'.repeat(64),chunk_ordinal:0,chunk_sha256:source.chunk_sha256};
test('target binding client posts only fixed route metadata and rejects missing exact binding',async()=>{const requests=[];const client=createPromotionGatewayClient({run,registryId:'registry',bearerTokenProvider:async()=> 'synthetic',fetchImpl:async(url,init)=>{requests.push({url:String(url),body:JSON.parse(init.body),redirect:init.redirect});return new Response(JSON.stringify({schema:'cfo-prepared-binding-page-v1',run_id:run.run_id,bindings:[prepared]}),{status:200});}});assert.deepEqual(await client.findPreparedBinding({source_ref:source}),prepared);assert.equal(requests[0].url.endsWith('/source/'+run.run_id+'/cfo-text-bindings'),true);assert.deepEqual(requests[0].body,{run,document_ordinal:0});assert.equal(requests[0].redirect,'error');await assert.rejects(client.findPreparedBinding({source_ref:{...source,chunk_sha256:'2'.repeat(64)}}),{code:'candidate_promotion_source_changed'});});

test('target binding client rejects an altered full target run and oversized gateway body',async()=>{
 const changed={...run,manifest_sha256:'c'.repeat(64)};const bad=createPromotionGatewayClient({run,registryId:'registry',bearerTokenProvider:async()=> 'synthetic',fetchImpl:async()=>new Response('x'.repeat(512*1024+1),{status:200})});
 await assert.rejects(bad.findPreparedBinding({source_ref:source,target:changed}),{code:'candidate_promotion_source_changed'});
 await assert.rejects(bad.findPreparedBinding({source_ref:source}),{code:'candidate_promotion_gateway_invalid'});
});
