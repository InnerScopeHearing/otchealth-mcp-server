import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyMaterializationReceipt, type MaterializationContext } from './materialized-catalog-pin.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:any):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const policy=sha('policy');
const logicalSource=sha(canonical({room:'finance',source_index:'finance-cfo-source-docs',url:'https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl'}));
function fixture(scope?:'all_cfo_source_documents'){
 const prefixes=scope?[]:['board/']; const catalogContent=sha('catalog bytes');
 const binding:any={schema:'cfo-catalog-materialization-v1',cohort_id:'cohort-1',policy_sha256:policy,source_prefixes_sha256:sha(canonical([...prefixes].sort())),source_version_id:'source-v1',source_etag_sha256:sha('etag'),source_catalog_content_sha256:sha('source bytes'),source_bytes:12,catalog_content_sha256:catalogContent,catalog_source_sha256:logicalSource,catalog_bytes:13,counts:{source_rows:1,eligible_rows:1,duplicate_rows:0,excluded:{}},lineage:'catalog_association_only',source_current_checked:true,...(scope?{source_scope:scope}:{})};
 const bindingSha=sha(canonical(binding)); const catalogKey=`graph-trial/20260909/materialized-cfo/cohort-1/${bindingSha}/${catalogContent}.jsonl`;
 const receipt={...binding,status:'published',published:true,catalog_key:catalogKey,catalog_version_id:'catalog-v1',binding_sha256:bindingSha};
 const body=Buffer.from(canonical(receipt));
 const context:MaterializationContext={cohort_id:'cohort-1',policy_sha256:policy,source_prefixes:prefixes, ...(scope?{source_scope:scope}:{}),catalog_key:catalogKey,catalog_source_sha256:logicalSource,materialization:{catalog_content_sha256:catalogContent,source_catalog_version_id:'source-v1',materialization_receipt_key:catalogKey.replace(/\.jsonl$/,'.receipt.json'),materialization_receipt_sha256:sha(body),catalog_version_id:'catalog-v1'}};
 return {body,context};
}
function get(body:Buffer,version='receipt-v1'){return async()=>({status:200,headers:new Headers({'x-amz-version-id':version}),body});}
test('accepts only a raw-byte-pinned immutable receipt bound to the exact configured authority',async()=>{const f=fixture();const result=await verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000));assert.equal(result.catalogContentSha256,f.context.materialization.catalog_content_sha256);assert.equal(result.catalogVersionId,'catalog-v1');});
test('rejects receipt byte changes, no receipt version, and invented policy authority',async()=>{const f=fixture();const changed=Buffer.from(f.body);changed[0]^=1;await assert.rejects(verifyMaterializationReceipt(f.context,get(changed),AbortSignal.timeout(1000)),/materialization_pin_invalid/);await assert.rejects(verifyMaterializationReceipt(f.context,get(f.body,'null'),AbortSignal.timeout(1000)),/materialization_pin_invalid/);await assert.rejects(verifyMaterializationReceipt({...f.context,policy_sha256:sha('invented')},get(f.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);});
test('requires the explicit all-CFO scope field and its empty source-prefix binding',async()=>{const f=fixture('all_cfo_source_documents');await assert.doesNotReject(verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000)));await assert.rejects(verifyMaterializationReceipt({...f.context,source_prefixes:['board/']},get(f.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);});
