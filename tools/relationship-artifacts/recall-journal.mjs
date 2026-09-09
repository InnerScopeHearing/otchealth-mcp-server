import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(v).digest('hex');
const clone=v=>structuredClone(v);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const runValid=r=>exact(r,['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])&&r.ref_version==='neptune-trial-active-run-ref-v1'&&r.scope==='finance'&&/^run_[a-f0-9]{64}$/.test(r.run_id)&&r.run_id==='run_'+hash(canonical(Object.fromEntries(Object.entries(r).filter(([key])=>key!=='run_id'))));
const entryValid=e=>exact(e,['run','producer_id'])&&runValid(e.run)&&/^[a-z][a-z0-9-]{0,63}$/.test(e.producer_id);
const identity=e=>e.run.run_id+'/'+e.producer_id;

/** Local metadata journal. Sealed, fsynced records are linked create-only, never overwritten. */
export function createFileRecallJournal(directory,{maxRecords=10000}={}){
 if(typeof directory!=='string'||!directory||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>100000)fail('recall_journal_configuration');
 const root=resolve(directory);
 async function read(){
  await mkdir(root,{recursive:true});const names=(await readdir(root)).filter(n=>/^\d{8}\.json$/.test(n)).sort();
  if(names.length>maxRecords)fail('recall_journal_limit');let prior=null;const records=[];
  for(let i=0;i<names.length;i++){
   if(names[i]!==String(i+1).padStart(8,'0')+'.json')fail('recall_journal_gap');
   const bytes=await readFile(join(root,names[i]));if(bytes.length>16384)fail('recall_journal_corrupt');let record;try{record=JSON.parse(bytes.toString('utf8'));}catch{fail('recall_journal_corrupt');}
   if(!exact(record,['schema','revision','parent_sha256','event','sha256'])||record.schema!=='relationship-recall-journal-record-v1'||record.revision!==i+1||record.parent_sha256!==prior||record.sha256!==hash(canonical({schema:record.schema,revision:record.revision,parent_sha256:record.parent_sha256,event:record.event})))fail('recall_journal_corrupt');
   records.push(record.event);prior=record.sha256;
  }
  return{revision:names.length,sha256:prior,events:records};
 }
 async function append(expected,event){
  const snapshot=await read();if(snapshot.revision!==expected.revision||snapshot.sha256!==expected.sha256)return false;
  if(snapshot.revision>=maxRecords)fail('recall_journal_limit');
  const content={schema:'relationship-recall-journal-record-v1',revision:snapshot.revision+1,parent_sha256:snapshot.sha256,event:clone(event)};
  const bytes=Buffer.from(canonical({...content,sha256:hash(canonical(content))}));if(bytes.length>16384)fail('recall_journal_event_too_large');
  const temporary=join(root,'.pending-'+randomUUID()),target=join(root,String(content.revision).padStart(8,'0')+'.json');let handle;
  try{handle=await open(temporary,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
   try{await link(temporary,target);}catch(error){if(error.code==='EEXIST')return false;throw error;}return true;
  }finally{if(handle)await handle.close();await unlink(temporary).catch(()=>{});}
 }
 return Object.freeze({read,append});
}

function reduce(events){
 const rows=new Map();for(const event of events){
  if(!event||!entryValid(event.entry))fail('recall_journal_event_invalid');const key=identity(event.entry),old=rows.get(key);
  if(event.operation==='admitted'&&exact(event,['operation','entry'])){if(old)fail('recall_journal_duplicate');rows.set(key,{...clone(event.entry),artifact_ref:null});}
  else if(event.operation==='published'&&exact(event,['operation','entry','artifact_ref'])){if(!old||old.artifact_ref)fail('recall_journal_publication_conflict');rows.set(key,{...old,artifact_ref:clone(event.artifact_ref)});}
  else fail('recall_journal_event_invalid');
 }
 return [...rows.values()];
}

/** Trusted composition only. Admission verification and historical readers are required dependencies. */
export function createRelationshipRecallHost({journal,recall,verifyAdmission,readers}={}){
 if(typeof journal?.read!=='function'||typeof journal?.append!=='function'||typeof recall?.recall!=='function'||typeof verifyAdmission!=='function'||!Array.isArray(readers))fail('recall_host_configuration');
 const map=new Map(readers.map(r=>[r.run_id+'/'+r.producer_id,r]));if(map.size!==readers.length)fail('recall_host_configuration');
 async function admitted(entry){
  if(!entryValid(entry)||!map.has(identity(entry)))fail('recall_host_scope');entry=clone(entry);
  // The dependency validates the actual issued admission. A matching run digest alone is insufficient.
  if(await verifyAdmission(clone(entry))!==true)fail('recall_host_admission_denied');
  for(let attempt=0;attempt<8;attempt++){const state=await journal.read(),rows=reduce(state.events),old=rows.find(r=>identity(r)===identity(entry));if(old)return clone(old);
   if(await journal.append(state,{operation:'admitted',entry}))return{...entry,artifact_ref:null};}
  fail('recall_host_conflict');
 }
 async function publish(entry,artifactRef,{signal}={}){
  if(!entryValid(entry))fail('recall_host_scope');entry=clone(entry);artifactRef=clone(artifactRef);const reader=map.get(identity(entry));if(!reader)fail('recall_host_scope');
  const checked=await reader.readArtifact(artifactRef,{signal});if(checked?.authority?.authenticated_gateway!==true||checked.authority.caller_seat!=='cfo'||checked.authority.producer_id!==entry.producer_id||checked.payload?.schema!=='resolution-history-v1'||canonical(checked.payload.run)!==canonical(entry.run))fail('recall_host_publication_denied');
  for(let attempt=0;attempt<8;attempt++){const state=await journal.read(),old=reduce(state.events).find(r=>identity(r)===identity(entry));if(!old)fail('recall_host_not_admitted');if(old.artifact_ref){if(canonical(old.artifact_ref)!==canonical(artifactRef))fail('recall_host_publication_conflict');return clone(old);}
   if(await journal.append(state,{operation:'published',entry,artifact_ref:artifactRef}))return{...entry,artifact_ref:artifactRef};}
  fail('recall_host_conflict');
 }
 async function retrieve(query,{signal,historyKeys}={}){
  if(historyKeys!==undefined&&(!Array.isArray(historyKeys)||historyKeys.some(key=>typeof key!=='string')||new Set(historyKeys).size!==historyKeys.length))fail('recall_host_history_selection');
  const state=await journal.read(),published=reduce(state.events).filter(r=>r.artifact_ref!==null);
  const selected=historyKeys===undefined?published:published.filter(r=>historyKeys.includes(identity(r)));
  if(historyKeys!==undefined&&(!Array.isArray(historyKeys)||new Set(historyKeys).size!==historyKeys.length||selected.length!==historyKeys.length))fail('recall_host_history_selection');
  return recall.recall({histories:selected,query:clone(query)},{signal});
 }
 return Object.freeze({admitted,publish,retrieve,inspect:async()=>reduce((await journal.read()).events)});
}
