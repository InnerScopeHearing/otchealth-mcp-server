import {createHash} from 'node:crypto';
const HASH=/^[a-f0-9]{64}$/,RUN=/^run_[a-f0-9]{64}$/;
const exact=(v,k)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===[...k].sort().join('\0');
const fail=code=>{throw Object.assign(Error(code),{code});};
const active=s=>{if(s?.aborted)fail('candidate_promotion_cancelled');};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const runValid=v=>{if(!exact(v,['ref_version','run_id','purpose','scope','run_version','manifest_sha256'])||v.ref_version!=='neptune-trial-active-run-ref-v1'||!RUN.test(v.run_id)||v.scope!=='finance'||!HASH.test(v.manifest_sha256)||typeof v.purpose!=='string'||typeof v.run_version!=='string')return false;const {run_id,...core}=v;return run_id==='run_'+createHash('sha256').update(canonical(core)).digest('hex');};
const binding=v=>{
 const keys=['schema','run_id','room','source_index','catalog_manifest_sha256','document_ordinal','source_document_version','catalog_source_sha256','snapshot_id','prepared_manifest_sha256','sidecar_content_sha256','chunk_ordinal','chunk_sha256'];
 if(!exact(v,keys)||v.schema!=='cfo-prepared-chunk-binding-v1'||!RUN.test(v.run_id)||v.room!=='finance'||v.source_index!=='finance-cfo-source-docs'||v.document_ordinal!==0||!HASH.test(v.catalog_manifest_sha256)||!HASH.test(v.catalog_source_sha256)||!/^txtsnap_[a-f0-9]{64}$/.test(v.snapshot_id)||!HASH.test(v.prepared_manifest_sha256)||!HASH.test(v.sidecar_content_sha256)||!Number.isInteger(v.chunk_ordinal)||v.chunk_ordinal<0||v.chunk_ordinal>=100||typeof v.source_document_version!=='string'||!HASH.test(v.chunk_sha256))fail('candidate_promotion_gateway_invalid');return structuredClone(v);
};
async function json(response,signal){
 active(signal);const limit=512*1024,reader=response.body?.getReader?.();let bytes;
 if(reader){const chunks=[];let size=0;try{for(;;){active(signal);const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit){await reader.cancel().catch(()=>{});fail('candidate_promotion_gateway_invalid');}chunks.push(Buffer.from(next.value));}bytes=Buffer.concat(chunks,size);}catch(error){await reader.cancel().catch(()=>{});throw error;}}
 else {bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>limit)fail('candidate_promotion_gateway_invalid');}
 active(signal);try{return JSON.parse(bytes.toString('utf8'));}catch{fail('candidate_promotion_gateway_invalid');}
}
/** Authenticated metadata-only bridge to the target-run preparation and registry routes. */
export function createPromotionGatewayClient({run,bearerTokenProvider,fetchImpl=globalThis.fetch,registryId}={}){
 if(!runValid(run)||typeof bearerTokenProvider!=='function'||typeof fetchImpl!=='function'||typeof registryId!=='string'||!registryId)fail('candidate_promotion_gateway_configuration');
 async function post(path,body,signal){active(signal);const token=await bearerTokenProvider(Object.freeze({seat:'cfo'}),{signal});active(signal);if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('candidate_promotion_gateway_auth');const response=await fetchImpl('https://mcp.otchealth.app/graph-worker/v1/'+path,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal});if(!response||response.status!==200)fail([401,403].includes(response?.status)?'candidate_promotion_gateway_denied':'candidate_promotion_gateway_unknown');return json(response,signal);}
 return Object.freeze({
  async findPreparedBinding({source_ref,target=run},{signal}={}){if(!exact(source_ref,['source_document_version','chunk_sha256'])||typeof source_ref.source_document_version!=='string'||!HASH.test(source_ref.chunk_sha256)||!runValid(target)||canonical(target)!==canonical(run))fail('candidate_promotion_source_changed');const page=await post(`source/${encodeURIComponent(run.run_id)}/cfo-text-bindings`,{run,document_ordinal:0},signal);if(!exact(page,['schema','run_id','bindings'])||page.schema!=='cfo-prepared-binding-page-v1'||page.run_id!==run.run_id||!Array.isArray(page.bindings)||page.bindings.length<1||page.bindings.length>100)fail('candidate_promotion_gateway_invalid');const found=page.bindings.map(binding).filter(v=>v.source_document_version===source_ref.source_document_version&&v.chunk_sha256===source_ref.chunk_sha256);if(found.length!==1)fail('candidate_promotion_source_changed');return Object.freeze(found[0]);},
  async readiness({source_binding_sha256},{signal}={}){if(!HASH.test(source_binding_sha256))fail('candidate_promotion_gateway_invalid');return post(`identity-registry/${encodeURIComponent(registryId)}/readiness`,{run_id:run.run_id,source_binding_sha256},signal);},
 });
}
