import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFileRecallJournal,createRelationshipRecallHost } from './recall-journal.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(v).digest('hex');
const entry=n=>{const run={ref_version:'neptune-trial-active-run-ref-v1',purpose:'synthetic-recall',scope:'finance',run_version:'v1',manifest_sha256:hash(n)};return{run:{...run,run_id:'run_'+hash(canonical(run))},producer_id:'synthetic-reviewer'};};
test('create-only journal append preserves previous sealed commits and CAS rejects a concurrent writer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'synthetic-recall-journal-'));try{
  const a=createFileRecallJournal(dir),b=createFileRecallJournal(dir),empty=await a.read();
  const races=await Promise.all([a.append(empty,{operation:'admitted',entry:entry('one')}),b.append(empty,{operation:'admitted',entry:entry('two')})]);assert.equal(races.filter(Boolean).length,1);
  await writeFile(join(dir,'.pending-crashed-writer'),'partial');const fresh=createFileRecallJournal(dir),saved=await fresh.read();assert.equal(saved.revision,1);assert.equal(saved.events.length,1);
  assert.equal(await fresh.append(saved,{operation:'admitted',entry:entry('three')}),true);assert.equal((await fresh.read()).revision,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('admission 2 without publication 2 leaves history 1 selected after reconstructing the host',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'synthetic-recall-host-'));try{
  const one=entry('one'),two=entry('two'),ref={synthetic:'ref-one'},selected=[];
  const readers=[one,two].map(e=>({run_id:e.run.run_id,producer_id:e.producer_id,readArtifact:async()=>({payload:{schema:'resolution-history-v1',run:e.run},authority:{authenticated_gateway:true,caller_seat:'cfo',producer_id:e.producer_id}})}));
  const options={journal:createFileRecallJournal(dir),readers,verifyAdmission:async()=>true,recall:{recall:async input=>{selected.push(input.histories);return{synthetic:true};}}};
  const first=createRelationshipRecallHost(options);await first.admitted(one);await first.publish(one,ref);await first.admitted(two);
  const restarted=createRelationshipRecallHost({...options,journal:createFileRecallJournal(dir)});await restarted.retrieve({synthetic:true});assert.deepEqual(selected[0],[{...one,artifact_ref:ref}]);
  assert.equal((await restarted.inspect()).filter(e=>e.artifact_ref===null).length,1);await restarted.publish(one,ref);assert.equal((await options.journal.read()).revision,3);
  await assert.rejects(restarted.publish(one,{synthetic:'other-ref'}),{code:'recall_host_publication_conflict'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('changed sealed journal bytes and denied admission fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'synthetic-recall-corruption-'));try{
  const journal=createFileRecallJournal(dir),one=entry('one');const host=createRelationshipRecallHost({journal,readers:[{run_id:one.run.run_id,producer_id:one.producer_id}],verifyAdmission:async()=>false,recall:{recall:async()=>{throw Error('unexpected');}}});
  await assert.rejects(host.admitted(one),{code:'recall_host_admission_denied'});assert.equal((await journal.read()).revision,0);
  await journal.append(await journal.read(),{operation:'admitted',entry:one});await writeFile(join(dir,'00000001.json'),'{}');await assert.rejects(journal.read(),{code:'recall_journal_corrupt'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
