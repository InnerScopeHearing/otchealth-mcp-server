import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelationshipPublicationStore, relationshipPublicationStoreTest } from './relationship-publication-store.js';

test('publication XML decodes each original entity once and rejects unknown entities',()=>{
 const {xmlDecode}=relationshipPublicationStoreTest;
 assert.equal(xmlDecode('&amp;lt; &amp;amp; &amp;quot;'),'&lt; &amp; &quot;');
 assert.equal(xmlDecode('&lt;&gt;&quot;&apos;&amp;'),'< > " \' &'.replaceAll(' ',''));
 assert.throws(()=>xmlDecode('&unknown;'),/xml/);
 assert.throws(()=>xmlDecode('bare & text'),/xml/);
});

const run='run_'+'a'.repeat(64), body=Buffer.from('{"schema":"synthetic"}');
const key=`graph-trial/20260908/relationship-publications/cfo/synthetic/synthetic-producer/runs/${run}.json`;

test('corporate publication writes, reads and lists only the CLO completion namespace',async()=>{
 const paths:string[]=[];let saved:Buffer|undefined;
 const prefix='graph-trial/20260912/relationship-publications/clo/clo-company-catalog-20260912/clo-relationship-worker/runs/';
 const store=createRelationshipPublicationStore({callerAgent:'clo',cohort:'clo-company-catalog-20260912',producer:'clo-relationship-worker',resolveCredentials:async()=>({accessKeyId:'synthetic',secretAccessKey:'synthetic'}),fetch:async(url,init)=>{
  const target=new URL(String(url));paths.push(target.pathname);
  if(target.searchParams.has('list-type')){
   assert.equal(target.searchParams.get('prefix'),prefix);
   return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${prefix}${run}.json</Key></Contents></ListBucketResult>`);
  }
  assert.equal(target.pathname,'/'+prefix+run+'.json');
  if(init?.method==='PUT'){saved=Buffer.from(init.body as Uint8Array);return new Response('',{status:201});}
  return new Response(saved as never,{headers:{'x-amz-version-id':'v1','x-amz-server-side-encryption':'AES256'}});
 }});
 await store.putCreateOnly({runId:run,body},new AbortController().signal);
 const page=await store.list({limit:2,signal:new AbortController().signal});
 assert.equal(page.records.length,1);assert.ok(paths.every(path=>!path.includes('/cfo/')));
 assert.throws(()=>createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic',callerAgent:'clo-personal' as any}),/namespace/);
});
test('publication store creates with immutable S3 headers then verifies the durable record',async()=>{
 const calls:Array<{method:string;headers:Record<string,string>}>=[];let saved:Buffer|undefined;
 const store=createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic-producer',resolveCredentials:async()=>({accessKeyId:'AKID',secretAccessKey:'synthetic'}),signRequest:o=>({headers:{...(o.extraHeaders??{})}}),fetch:async(_url,init)=>{calls.push({method:init?.method??'',headers:init?.headers as Record<string,string>});if(init?.method==='PUT'){saved=Buffer.from(init.body as Uint8Array);return new Response('',{status:201});}return saved?new Response(saved as never,{headers:{'x-amz-version-id':'v1','x-amz-server-side-encryption':'AES256'}}):new Response('',{status:404});}});
 const result=await store.putCreateOnly({runId:run,body},new AbortController().signal);
 assert.equal(result.found,true);if(!result.found)throw Error('missing');assert.deepEqual(result.body,body);assert.equal(calls[0]!.headers['if-none-match'],'*');assert.equal(calls[0]!.headers['x-amz-server-side-encryption'],'AES256');
});
test('publication store rejects invalid namespace, records, and cursors before network',async()=>{
 assert.throws(()=>createRelationshipPublicationStore({cohort:'../bad',producer:'x'}),/namespace/);
 const store=createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic-producer',resolveCredentials:async()=>null});
 await assert.rejects(store.putCreateOnly({runId:run,body:Buffer.from('[]')},new AbortController().signal),/record/);
 await assert.rejects(store.list({after:'bad',limit:1,signal:new AbortController().signal}),/cursor/);
});
test('publication store marks a failed grant GET with a safe typed upstream status',async()=>{
 const store=createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic-producer',resolveCredentials:async()=>({accessKeyId:'synthetic',secretAccessKey:'synthetic'}),fetch:async()=>new Response('',{status:403})});
 await assert.rejects(store.get(run,new AbortController().signal),(error:any)=>error?.code==='get'&&error?.publicationStoreError===true&&error?.upstreamStatus===403);
});


test('publication S3 pages 66 retained records using the real bounded list parser',async()=>{
 const ids=Array.from({length:66},(_,i)=>'run_'+i.toString(16).padStart(64,'0')),calls:string[]=[],prefix='graph-trial/20260908/relationship-publications/cfo/synthetic/synthetic-producer/runs/';
 const store=createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic-producer',resolveCredentials:async()=>({accessKeyId:'synthetic',secretAccessKey:'synthetic'}),fetch:async input=>{const u=new URL(String(input));calls.push(u.href);if(u.searchParams.get('list-type')){assert.equal(u.searchParams.get('prefix'),prefix);const after=u.searchParams.get('start-after'),remaining=ids.filter(id=>!after||prefix+id+'.json'>after),selected=remaining.slice(0,Number(u.searchParams.get('max-keys')));return new Response('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>'+String(remaining.length>selected.length)+'</IsTruncated>'+selected.map(id=>'<Contents><Key>'+prefix+id+'.json</Key></Contents>').join('')+'</ListBucketResult>');}return new Response(body as never,{headers:{'x-amz-version-id':'v1','x-amz-server-side-encryption':'AES256'}});}});
 const first=await store.list({limit:64,signal:new AbortController().signal}),second=await store.list({after:first.next,limit:64,signal:new AbortController().signal});assert.equal(first.records.length,64);assert.equal(second.records.length,2);assert.equal(second.next,undefined);assert.equal(calls.filter(x=>new URL(x).searchParams.has('list-type')).length,2);
});

test('publication storage cancels stalled response body and rejects absent immutable version',async()=>{
 let cancelled=false,credentials=0;const ctl=new AbortController();
 const store=createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic-producer',resolveCredentials:async()=>{credentials++;return{accessKeyId:'synthetic',secretAccessKey:'synthetic'};},fetch:async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel(){cancelled=true;}}),{headers:{'x-amz-version-id':'v1','x-amz-server-side-encryption':'AES256'}})});
 const pending=store.get(run,ctl.signal);setTimeout(()=>ctl.abort(),10);await assert.rejects(pending,/deadline/);assert.equal(cancelled,true);await assert.rejects(store.get(run,ctl.signal),/deadline/);assert.equal(credentials,1);
 const noVersion=createRelationshipPublicationStore({cohort:'synthetic',producer:'synthetic-producer',resolveCredentials:async()=>({accessKeyId:'synthetic',secretAccessKey:'synthetic'}),fetch:async()=>new Response(body as never,{headers:{'x-amz-version-id':'null','x-amz-server-side-encryption':'AES256'}})});await assert.rejects(noVersion.get(run,new AbortController().signal),/get/);
});
