import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyMaterializationReceipt, type MaterializationContext } from './materialized-catalog-pin.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:any):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const policy=sha('policy');
const logicalSource=sha(canonical({room:'finance',source_index:'finance-cfo-source-docs',url:'https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl'}));
function fixture(scope?:'all_cfo_source_documents',amend?:(binding:any)=>void){
 const prefixes=scope?[]:['board/']; const catalogContent=sha('catalog bytes');
 const binding:any={schema:'cfo-catalog-materialization-v1',cohort_id:'cohort-1',policy_sha256:policy,source_prefixes_sha256:sha(canonical([...prefixes].sort())),source_version_id:'source-v1',source_etag_sha256:sha('etag'),source_catalog_content_sha256:sha('source bytes'),source_bytes:12,catalog_content_sha256:catalogContent,catalog_source_sha256:logicalSource,catalog_bytes:13,counts:{source_rows:1,eligible_rows:1,duplicate_rows:0,excluded:{}},lineage:'catalog_association_only',source_current_checked:true,...(scope?{source_scope:scope}:{})};
 amend?.(binding);
 const bindingSha=sha(canonical(binding)); const catalogKey=`graph-trial/20260909/materialized-cfo/${binding.cohort_id}/${bindingSha}/${catalogContent}.jsonl`;
 const receipt={...binding,status:'published',published:true,catalog_key:catalogKey,catalog_version_id:'catalog-v1',binding_sha256:bindingSha};
 const body=Buffer.from(canonical(receipt));
 const context:MaterializationContext={cohort_id:binding.cohort_id,policy_sha256:policy,source_prefixes:prefixes, ...(scope?{source_scope:scope}:{}),catalog_key:catalogKey,catalog_source_sha256:logicalSource,materialization:{catalog_content_sha256:catalogContent,source_catalog_version_id:'source-v1',materialization_receipt_key:catalogKey.replace(/\.jsonl$/,'.receipt.json'),materialization_receipt_sha256:sha(body),catalog_version_id:'catalog-v1'}};
 return {body,context};
}
function get(body:Buffer,version='receipt-v1'){return async()=>({status:200,headers:new Headers({'x-amz-version-id':version}),body});}
test('accepts only a raw-byte-pinned immutable receipt bound to the exact configured authority',async()=>{const f=fixture();const result=await verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000));assert.equal(result.catalogContentSha256,f.context.materialization.catalog_content_sha256);assert.equal(result.catalogVersionId,'catalog-v1');});
test('rejects receipt byte changes, no receipt version, and invented policy authority',async()=>{const f=fixture();const changed=Buffer.from(f.body);changed[0]^=1;await assert.rejects(verifyMaterializationReceipt(f.context,get(changed),AbortSignal.timeout(1000)),/materialization_pin_invalid/);await assert.rejects(verifyMaterializationReceipt(f.context,get(f.body,'null'),AbortSignal.timeout(1000)),/materialization_pin_invalid/);await assert.rejects(verifyMaterializationReceipt({...f.context,policy_sha256:sha('invented')},get(f.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);});
test('requires the explicit all-CFO scope field and its empty source-prefix binding',async()=>{const f=fixture('all_cfo_source_documents');await assert.doesNotReject(verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000)));await assert.rejects(verifyMaterializationReceipt({...f.context,source_prefixes:['board/']},get(f.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);});

function withQuarantine(binding:any){
 binding.counts={source_rows:3,eligible_rows:1,duplicate_rows:0,excluded:{unknown_extraction_quarantine:2}};
 binding.quarantine_exclusions=['first','second'].map(id=>({proposal_key:sha(id+'proposal'),run_id:'run_'+sha(id+'run'),operation_id:'subop_'+sha(id+'operation'),source_document_version:'docv_'+sha(id+'version'),catalog_source_sha256:sha(id+'content'),source_path_sha256:sha(id+'path')}));
}
test('accepts exact quarantine lineage bound into the source-owned receipt and configured digest',async()=>{
 const f=fixture('all_cfo_source_documents',withQuarantine);
 await assert.doesNotReject(verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000)));
 const changed=JSON.parse(f.body.toString());changed.quarantine_exclusions[0].operation_id='subop_'+sha('changed');
 await assert.rejects(verifyMaterializationReceipt(f.context,get(Buffer.from(canonical(changed))),AbortSignal.timeout(1000)),/materialization_pin_invalid/);
});
test('rejects missing, malformed, duplicate or inconsistent quarantine lineage even when receipt bytes are repinned',async()=>{
 const mutations=[
  (b:any)=>{delete b.quarantine_exclusions;},
  (b:any)=>{b.quarantine_exclusions=null;},
  (b:any)=>{b.quarantine_exclusions[0].unexpected=true;},
  (b:any)=>{b.quarantine_exclusions[1]=b.quarantine_exclusions[0];},
  (b:any)=>{b.quarantine_exclusions[0].operation_id='invalid';},
  (b:any)=>{b.counts={source_rows:2,eligible_rows:1,duplicate_rows:0,excluded:{unknown_extraction_quarantine:1}};},
 ];
 for(const mutate of mutations){const f=fixture('all_cfo_source_documents',b=>{withQuarantine(b);mutate(b);});await assert.rejects(verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);}
 const scoped=fixture(undefined,withQuarantine);
 await assert.rejects(verifyMaterializationReceipt(scoped.context,get(scoped.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);
});
function withCompleted(binding:any){
 withQuarantine(binding);binding.cohort_id='cfo-catalog-successor-unknown-20260912';
 binding.counts.source_rows+=53;binding.counts.excluded.already_published_source=53;
 const digest=sha('synthetic completed publication manifest');
 binding.completed_publication_exclusion_manifest={schema:'cfo-completed-publication-exclusion-manifest-pointer-v1',key:`graph-trial/20260909/materialized-cfo/${binding.cohort_id}/completed-publication-exclusions/${digest}.json`,version_id:'manifest-v1',sha256:digest,count:53};
}
test('accepts a compact completed-publication manifest pin bound to exact counted exclusions',async()=>{
 const f=fixture('all_cfo_source_documents',b=>{withCompleted(b);b.completed_publication_exclusion_manifest.version_id='3/L4.synthetic+version~1';});
 await assert.doesNotReject(verifyMaterializationReceipt(f.context,get(f.body,'3/receipt+version~1'),AbortSignal.timeout(1000)));
});
test('rejects fabricated completed counts and noncanonical manifest pointers even after repinning receipt bytes',async()=>{
 const mutations=[
  (b:any)=>{delete b.completed_publication_exclusion_manifest;},
  (b:any)=>{b.completed_publication_exclusion_manifest.count=52;},
  (b:any)=>{b.completed_publication_exclusion_manifest.version_id='null';},
  (b:any)=>{b.completed_publication_exclusion_manifest.key='graph-trial/outside.json';},
  (b:any)=>{b.completed_publication_exclusion_manifest.sha256=sha('other');},
  (b:any)=>{b.completed_publication_exclusion_manifest.extra=true;},
  (b:any)=>{b.completed_publication_exclusion_manifest.count=101;b.counts.source_rows=104;b.counts.excluded.already_published_source=101;},
 ];
 for(const mutate of mutations){const f=fixture('all_cfo_source_documents',b=>{withCompleted(b);mutate(b);});await assert.rejects(verifyMaterializationReceipt(f.context,get(f.body),AbortSignal.timeout(1000)),/materialization_pin_invalid/);}
});
