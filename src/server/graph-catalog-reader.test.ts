import assert from 'node:assert/strict';
import test from 'node:test';
import { readPinnedGraphCatalog, type GraphCatalogRawS3 } from './graph-catalog-reader.js';
import { createHash } from 'node:crypto';
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
test('pins raw bytes and an S3 version before and after the catalog read',async()=>{
 const body='{"path":"a"}\n',digest=createHash('sha256').update(body).digest('hex');let heads=0;
  const s3:GraphCatalogRawS3=async r=>{if(r.method==='HEAD')heads++;return{status:200,headers:new Headers({etag:'"v1"','last-modified':createdAt,'content-length':String(Buffer.byteLength(body)),'x-amz-version-id':'version-1'}),body:r.method==='HEAD'?null:new Response(body).body};};
 const result=await readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,expectedContentSha256:digest,expectedVersionId:'version-1',s3});
 assert.equal(result.catalogContentSha256,digest);assert.equal(result.catalogVersionId,'version-1');assert.equal(heads,2);
 await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,expectedContentSha256:'b'.repeat(64),expectedVersionId:'version-1',s3}),/catalog_content_changed/);
 await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,expectedContentSha256:digest,expectedVersionId:'version-2',s3}),/catalog_version_changed/);
});
test('rejects a same-ETag catalog whose version changes after GET',async()=>{
 const body='{"path":"a"}\n';let heads=0;
  const s3:GraphCatalogRawS3=async r=>{const version=r.method==='HEAD'&&++heads===2?'version-2':'version-1';return{status:200,headers:new Headers({etag:'"stable"','last-modified':createdAt,'content-length':String(Buffer.byteLength(body)),'x-amz-version-id':version}),body:r.method==='HEAD'?null:new Response(body).body};};
 await assert.rejects(readPinnedGraphCatalog({key:'graph-trial/catalog.jsonl',sourceSha256:source,expectedVersionId:'version-1',s3}),/catalog_changed/);
});
