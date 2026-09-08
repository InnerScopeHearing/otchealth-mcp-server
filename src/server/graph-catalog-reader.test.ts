import assert from 'node:assert/strict';
import test from 'node:test';
import { readPinnedGraphCatalog, type GraphCatalogRawS3 } from './graph-catalog-reader.js';
const source='a'.repeat(64), createdAt='2026-09-08T00:00:00.000Z';
function harness(text:string, getStatus=200):GraphCatalogRawS3{return async r=>({status:r.method==='HEAD'?200:getStatus,headers:new Headers({etag:'"v1"','content-length':String(Buffer.byteLength(text)),'last-modified':createdAt}),body:r.method==='HEAD'?null:new ReadableStream({start(c){c.enqueue(Buffer.from(text));c.close();}})});}
test('reads bounded JSONL only after a matching pinned HEAD and GET',async()=>{const result=await readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,createdAt,s3:harness('{"path":"a"}\n')});assert.equal(result.catalogEtag,'"v1"');assert.deepEqual(result.rows,[{path:'a'}]);});
test('fails closed on a changed pinned object or oversized line',async()=>{await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,createdAt,s3:harness('{}\n',412)}),/catalog_changed/);await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,createdAt,s3:harness('x'.repeat(1024*1024+1))}),/catalog_line_too_large/);});


test('rejects impossible HEAD size before GET and rejects truncated or invalid UTF-8',async()=>{
 let requests=0;const s3:GraphCatalogRawS3=async()=>{requests++;return{status:200,headers:new Headers({etag:'"v1"','last-modified':createdAt,'content-length':String(192*1024*1024+1)}),body:null};};
 await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,s3}),/catalog_head_failed/);assert.equal(requests,1);
 const invalid=Buffer.from([0xff]);await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,s3:async r=>({status:200,headers:new Headers({etag:'"v1"','last-modified':createdAt,'content-length':'1'}),body:r.method==='HEAD'?null:new Response(invalid).body})}));
});
test('caller cancellation bounds an unresolved transport without a later GET',async()=>{
 let requests=0;const controller=new AbortController();const pending=readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,signal:controller.signal,s3:async()=>{requests++;return new Promise(()=>{});}});setTimeout(()=>controller.abort(),5);await assert.rejects(pending,/catalog_cancelled/);assert.equal(requests,1);
});
