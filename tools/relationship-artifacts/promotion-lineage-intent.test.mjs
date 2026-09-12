import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {createPromotionLineageIntentStore} from './promotion-lineage-intent.mjs';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
const run=(purpose,mark)=>{const core={ref_version:'neptune-trial-active-run-ref-v1',purpose,scope:'finance',run_version:'synthetic-v1',manifest_sha256:mark.repeat(64)};return{...core,run_id:'run_'+sha(core)}};
const parent=run('relationship-candidates','a'),target=run('relationship-promotion','b');
const ref={schema:'relationship-resolution-artifact-ref-v1',artifact_id:'resart_'+'c'.repeat(64),bucket:'synthetic-bucket',key:'synthetic/candidate.json',payload_sha256:'c'.repeat(64),version_id:'synthetic-v1',size_bytes:1};
const refs=[{source_document_version:'docv-synthetic',catalog_source_sha256:'f'.repeat(64),chunk_sha256:'d'.repeat(64)}];
const lineage={schema:'candidate-promotion-lineage-v2',parent_artifact_ref:ref,parent_run:parent,target_run:target,source_refs:refs,source_refs_sha256:sha(refs)};
const id={cohort_id:'synthetic',producer_id:'reviewer',run:target};
async function temp(){return mkdtemp(join(tmpdir(),'promotion-lineage-'));}
async function clean(path){assert.ok(resolve(path).startsWith(resolve(tmpdir())));await rm(path,{recursive:true,force:true});}

test('lineage intent is create-only, restart-durable, and retains exact parent and source refs',async()=>{const root=await temp();try{const store=createPromotionLineageIntentStore(root);const writes=await Promise.all(Array.from({length:8},()=>store.create(id,lineage)));assert.equal(writes.filter(x=>x.created).length,1);const saved=await createPromotionLineageIntentStore(root).get(id);assert.deepEqual(saved?.lineage,lineage);assert.deepEqual(saved?.identity,id);}finally{await clean(root);}});
test('lineage intent rejects a changed parent or changed source for the same target run',async()=>{const root=await temp();try{const store=createPromotionLineageIntentStore(root);await store.create(id,lineage);const changedParent={...lineage,parent_artifact_ref:{...ref,version_id:'synthetic-v2'}};await assert.rejects(store.create(id,changedParent),{code:'promotion_lineage_conflict'});const changedSource={...lineage,source_refs:[{...refs[0],chunk_sha256:'e'.repeat(64)}],source_refs_sha256:sha([{...refs[0],chunk_sha256:'e'.repeat(64)}])};await assert.rejects(store.create(id,changedSource),{code:'promotion_lineage_conflict'});}finally{await clean(root);}});
test('lineage intent rejects a target run mismatch before writing',async()=>{const root=await temp();try{const store=createPromotionLineageIntentStore(root);await assert.rejects(store.create(id,{...lineage,target_run:parent}),{code:'promotion_lineage_invalid'});assert.equal(await store.get(id),null);}finally{await clean(root);}});
