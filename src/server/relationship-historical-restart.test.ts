import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

for(const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'}))process.env[key]??=value;

const enabled=!!process.env.RELATIONSHIP_STORE_MODULE;
const fixtureUrl=new URL('../../tools/relationship-artifacts/historical-restart-fixture.mjs',import.meta.url);
const childUrl=new URL('../../tools/relationship-artifacts/historical-restart-child.mjs',import.meta.url);
const loader=fileURLToPath(new URL('../../tools/relationship-artifacts/typescript-test-loader.mjs',import.meta.url));
const runChild=(input:string,output:string)=>spawnSync(process.execPath,['--import',pathToFileURL(loader).href,fileURLToPath(childUrl),input,output],{encoding:'utf8',windowsHide:true,timeout:60000,env:process.env});

test('two actual durable runs retain a published immutable history through crash and restart', {skip:!enabled}, async()=>{
 const {createTwoRunHistoricalFixture}=await import(pathToFileURL(fileURLToPath(fixtureUrl)).href), root=mkdtempSync(join(tmpdir(),'relationship-history-restart-'));
 try{
  const f=await createTwoRunHistoricalFixture({journalDirectory:root}), first=f.entry(f.first.fixture.state.run), second=f.entry(f.second.fixture.state.run);
  await f.host.admitted(first); await f.host.publish(first,f.first.receipt.artifact_ref); await f.host.admitted(second);
  assert.equal((await f.host.inspect()).filter((x:any)=>x.artifact_ref).length,1);
  const r=f.first.receipt.artifact_ref,d=r.payload_sha256, old=await f.routes.app.inject({method:'GET',url:`/relationship-artifacts/v1/${first.run.run_id}/synthetic-reviewer-1/sha256/${d.slice(0,2)}/${d}.json?versionId=${encodeURIComponent(r.version_id)}`,headers:{authorization:'Bearer synthetic-history-token-value-1234'}}); assert.equal(old.statusCode,403);
  const input=join(root,'child-in.json'),output=join(root,'child-out.json'); writeFileSync(input,JSON.stringify({journalDirectory:root,snapshot:f.snapshot})); const child=runChild(input,output); assert.equal(child.status,0,child.stderr); const one=JSON.parse(readFileSync(output,'utf8')); assert.equal(one.ok,true,one.code); assert.equal(one.result.answer.status,'unsupported');
  await f.completeSecond(); await f.host.publish(second,f.second.receipt.artifact_ref); f.advanceMonths(); writeFileSync(input,JSON.stringify({journalDirectory:root,snapshot:f.snapshot})); const published=runChild(input,output); assert.equal(published.status,0,published.stderr); const both=JSON.parse(readFileSync(output,'utf8')); assert.equal(both.ok,true,both.code); assert.equal(both.result.answer.status,'qualified');
  await f.routes.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('history route invalidates changed premises, denies unauthorized reads and has no write route', {skip:!enabled},async()=>{
 const {createTwoRunHistoricalFixture}=await import(pathToFileURL(fileURLToPath(fixtureUrl)).href), root=mkdtempSync(join(tmpdir(),'relationship-history-denial-'));
 try{const f=await createTwoRunHistoricalFixture({journalDirectory:root}),a=f.entry(f.first.fixture.state.run),b=f.entry(f.second.fixture.state.run);await f.host.admitted(a);await f.host.publish(a,f.first.receipt.artifact_ref);await f.host.admitted(b);await f.completeSecond();await f.host.publish(b,f.second.receipt.artifact_ref);const answer=await f.host.retrieve(f.query);assert.equal(answer.answer.status,'qualified');const changed=await createTwoRunHistoricalFixture({journalDirectory:root,flags:{changed:true},snapshot:f.snapshot});assert.equal((await changed.host.retrieve({...changed.query,premise_ids:answer.answer.premise_ids})).answer.status,'invalidated');await changed.routes.close();for(const flags of [{deniedProducer:true},{deniedSource:true}]){const denied=await createTwoRunHistoricalFixture({journalDirectory:root,flags,snapshot:f.snapshot});await assert.rejects(denied.host.retrieve(denied.query));await denied.routes.close();} const ref=f.first.receipt.artifact_ref,d=ref.payload_sha256;const reply=await f.routes.app.inject({method:'PUT',url:`/relationship-history/v1/${f.first.fixture.state.run.run_id}/synthetic-reviewer-1/sha256/${d.slice(0,2)}/${d}.json?versionId=${encodeURIComponent(ref.version_id)}`,headers:{authorization:'Bearer synthetic-history-token-value-1234'}});assert.ok([404,405].includes(reply.statusCode));await f.routes.close();}finally{rmSync(root,{recursive:true,force:true});}
});
