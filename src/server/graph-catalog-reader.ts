/** Bounded finance catalog JSONL reader. HEAD metadata and If-Match pin every page. */
import { createHash } from 'node:crypto';
import { canonicalUri, resolveAwsCredentials, signRequest } from '../search/sigv4.js';
export const GRAPH_CATALOG_MAX_BYTES = 192 * 1024 * 1024;
export const GRAPH_CATALOG_MAX_ROWS = 100_000;
export const GRAPH_CATALOG_MAX_LINE_BYTES = 1024 * 1024;
const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const REGION = 'us-east-1';
export type GraphCatalogRawRequest = Readonly<{ method:'HEAD'|'GET';key:string;headers?:Record<string,string>;signal:AbortSignal }>;
export type GraphCatalogRawResponse = Readonly<{status:number;headers:Headers;body:ReadableStream<Uint8Array>|null}>;
export type GraphCatalogRawS3 = (request:GraphCatalogRawRequest)=>Promise<GraphCatalogRawResponse>;
export type PinnedCatalog = Readonly<{rows:readonly Record<string,unknown>[];catalogEtag:string;catalogSourceSha256:string;createdAt:string}>;
function safeKey(key:string):boolean {
  return typeof key==='string' && key.startsWith('graph-trial/') && key.length<=1024 &&
    !/[\\%?#\u0000-\u001f\u007f]/.test(key) && key===key.normalize('NFC') && !key.split('/').some(p=>p===''||p==='.'||p==='..');
}
function active(signal:AbortSignal){if(signal.aborted)throw new Error('catalog_cancelled');}
async function bounded<T>(fn:()=>Promise<T>,signal:AbortSignal):Promise<T>{
  active(signal);
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(new Error('catalog_cancelled'));};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{active(signal);return fn();}).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    if(signal.aborted)abort();
  });
}
async function cancel(reader:ReadableStreamDefaultReader<Uint8Array>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([Promise.resolve().then(()=>reader.cancel()).catch(()=>undefined),new Promise(resolve=>{timer=setTimeout(resolve,100);})]);
  clearTimeout(timer);
}
export const defaultGraphCatalogS3:GraphCatalogRawS3=async(request)=>{
  if(!safeKey(request.key))throw new Error('catalog_key_invalid');active(request.signal);
  const credentials=await bounded(()=>resolveAwsCredentials(),request.signal);active(request.signal);
  if(!credentials)throw new Error('catalog_credentials');
  const host=`${BUCKET}.s3.${REGION}.amazonaws.com`;
  const signed=signRequest({method:request.method,host,path:'/'+request.key,region:REGION,service:'s3',credentials,
    extraHeaders:{'x-amz-content-sha256':createHash('sha256').update('').digest('hex'),...(request.headers??{})}});
  const response=await bounded(()=>fetch('https://'+host+canonicalUri('/'+request.key),{
    method:request.method,headers:signed.headers,signal:request.signal,redirect:'error'}),request.signal);
  return {status:response.status,headers:response.headers,body:response.body};
};
export async function readPinnedGraphCatalog(input:Readonly<{key:string;sourceSha256:string;createdAt?:string;s3?:GraphCatalogRawS3;signal?:AbortSignal}>):Promise<PinnedCatalog>{
  if(!safeKey(input.key)||!/^[a-f0-9]{64}$/.test(input.sourceSha256))throw new Error('catalog_reader_request_invalid');
  const internal=new AbortController(),timer=setTimeout(()=>internal.abort(),45000);
  const signal=input.signal?AbortSignal.any([input.signal,internal.signal]):internal.signal,s3=input.s3??defaultGraphCatalogS3;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const head=await bounded(()=>s3({method:'HEAD',key:input.key,signal}),signal);active(signal);
    const etag=head.headers.get('etag'),size=Number(head.headers.get('content-length')),modified=head.headers.get('last-modified');
    if(head.status!==200||!etag||etag.length>160||!modified||!Number.isFinite(Date.parse(modified))||
      !Number.isSafeInteger(size)||size<1||size>GRAPH_CATALOG_MAX_BYTES)throw new Error('catalog_head_failed');
    const createdAt=new Date(modified).toISOString();
    if(input.createdAt!==undefined&&input.createdAt!==createdAt)throw new Error('catalog_timestamp_changed');
    const response=await bounded(()=>s3({method:'GET',key:input.key,headers:{'if-match':etag},signal}),signal);active(signal);
    if(response.status===412)throw new Error('catalog_changed');
    if(response.status!==200||response.headers.get('etag')!==etag||!response.body)throw new Error('catalog_get_failed');
    if(response.headers.has('content-length')&&Number(response.headers.get('content-length'))!==size)throw new Error('catalog_length_changed');
    reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
    const rows:Record<string,unknown>[]=[];let count=0,pending='';
    const parse=(line:string)=>{
      if(!line.trim())return;
      if(Buffer.byteLength(line)>GRAPH_CATALOG_MAX_LINE_BYTES)throw new Error('catalog_line_too_large');
      if(rows.length>=GRAPH_CATALOG_MAX_ROWS)throw new Error('catalog_too_many_rows');
      let value:unknown;try{value=JSON.parse(line);}catch{throw new Error('catalog_jsonl_invalid');}
      if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('catalog_jsonl_invalid');
      rows.push(value as Record<string,unknown>);
    };
    for(;;){
      const part=await bounded(()=>reader!.read(),signal);active(signal);if(part.done)break;
      count+=part.value.byteLength;if(count>size)throw new Error('catalog_length_changed');
      pending+=decoder.decode(part.value,{stream:true});let end:number;
      while((end=pending.indexOf('\n'))>=0){parse(pending.slice(0,end));pending=pending.slice(end+1);}
      if(Buffer.byteLength(pending)>GRAPH_CATALOG_MAX_LINE_BYTES)throw new Error('catalog_line_too_large');
    }
    pending+=decoder.decode();parse(pending);if(count!==size)throw new Error('catalog_length_changed');
    return Object.freeze({rows:Object.freeze(rows),catalogEtag:etag,catalogSourceSha256:input.sourceSha256,createdAt});
  }finally{clearTimeout(timer);internal.abort();if(reader)await cancel(reader);}
}
