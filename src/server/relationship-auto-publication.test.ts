import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import '../../tools/relationship-artifacts/paged-recall-host.test.mjs';
for(const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'}))process.env[key]??=value;
const enabled=!!process.env.RELATIONSHIP_STORE_MODULE,loader=fileURLToPath(new URL('../../tools/relationship-artifacts/typescript-test-loader.mjs',import.meta.url)),child=fileURLToPath(new URL('../../tools/relationship-artifacts/auto-publication-child.mjs',import.meta.url));
test('three successive actual durable documents publish automatically across restart without per-document policy edits',{skip:!enabled},async()=>{
 const url=new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs',import.meta.url),{createAutoPublicationFixture}=await import(url.href),root=mkdtempSync(join(tmpdir(),'auto-publication-'));let f;
 const execute=(payload:any)=>{const input=join(root,'in.json'),output=join(root,'out.json');writeFileSync(input,JSON.stringify(payload));const r=spawnSync(process.execPath,['--import',pathToFileURL(loader).href,child,input,output],{encoding:'utf8',windowsHide:true,timeout:60000,env:process.env});assert.equal(r.status,0,r.stderr);return JSON.parse(readFileSync(output,'utf8'));};
 try{
  f=await createAutoPublicationFixture();const policy=JSON.stringify(f.state.publicationPolicy);f.admit(0);await f.reviewAndPublish(0);f.admit(1);
  assert.equal(Object.keys(f.state.grants).length,1);assert.equal(f.receipts[1],null);assert.equal(Object.keys(f.state.objects).some(k=>k.includes(f.fixtures[1].state.run.run_id+'/relationship-producers/')),false);
  const pending=execute({snapshot:f.snapshot});assert.equal(pending.ok,true,pending.code);assert.equal(pending.result.page.items.length,1);
  await f.review(1);const resumed=execute({snapshot:f.snapshot,publishIndex:1});assert.equal(resumed.ok,true,resumed.code);assert.equal(resumed.result.page.items.length,2);await f.routes.close();f=await createAutoPublicationFixture({snapshot:resumed.snapshot});
  f.admit(2);await f.reviewAndPublish(2);assert.equal(Object.keys(f.state.grants).length,3);assert.equal(JSON.stringify(f.state.publicationPolicy),policy);f.state.now+=120*86400000;
  const final=execute({snapshot:f.snapshot});assert.equal(final.ok,true,final.code);assert.equal(final.result.page.items.length,3);assert.equal(final.result.recall.answer.status,'qualified');
  const changed=execute({snapshot:f.snapshot,flags:{changed:true},query:{...f.query,premise_ids:final.result.recall.answer.premise_ids}});assert.equal(changed.ok,true,changed.code);assert.equal(changed.result.recall.answer.status,'invalidated');
  for(const flags of [{deniedSource:true},{deniedProducer:true}]){const denied=execute({snapshot:f.snapshot,flags});assert.equal(denied.ok,false);}
 }finally{if(f)await f.routes.close();rmSync(root,{recursive:true,force:true});}
});

test('publication requires issued admission and refuses source revocation during the grant write',{skip:!enabled},async()=>{
 const {createAutoPublicationFixture}=await import(new URL('../../tools/relationship-artifacts/auto-publication-fixture.mjs',import.meta.url).href),flags:any={},f=await createAutoPublicationFixture({flags});
 try{
  f.admit(0);await f.review(0);const id=f.fixtures[0].state.run.run_id;
  f.state.admitted=[];await assert.rejects(f.publish(0));assert.equal(Object.keys(f.state.grants).length,0);
  f.state.admitted=[id];const pin=f.state.pins[id].admission,raw=f.state.objects[pin.key].body;f.state.objects[pin.key].body=Buffer.from('{}').toString('base64');await assert.rejects(f.publish(0));assert.equal(Object.keys(f.state.grants).length,0);f.state.objects[pin.key].body=raw;
  flags.revokeOnWrite=true;await assert.rejects(f.publish(0));await assert.rejects(f.host.list());
 }finally{await f.routes.close();}
});
