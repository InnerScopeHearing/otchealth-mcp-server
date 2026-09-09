import {createHash} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
export const HISTORY_STORE_ID='relationship-gateway-v1';
export function createReviewHistoryAuthority({run,producer,getAuthorization,fetchImpl=globalThis.fetch}){
 if(!/^run_[a-f0-9]{64}$/.test(run?.run_id??'')||!/^[a-z][a-z0-9-]{0,63}$/.test(producer??'')||typeof getAuthorization!=='function'||typeof fetchImpl!=='function')fail('relationship_authority_configuration');
 async function requestDecision(request,{signal}={}){
  
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
  bounded.throwIfAborted();const authorization=await getAuthorization({}, {signal:bounded});bounded.throwIfAborted();
  if(!/^Bearer [^\s]{16,8192}$/.test(authorization??''))fail('relationship_authority_auth');
  const response=await fetchImpl(`https://mcp.otchealth.app/relationship-artifacts/v1/${run.run_id}/${producer}/authorize`,{method:'POST',headers:{authorization,'content-type':'application/json'},body:canonical(request),redirect:'error',signal:bounded});
  if(response.status!==200){await response.body?.cancel();fail('relationship_authority_denied');}
  const reader=response.body?.getReader();if(!reader)fail('relationship_authority_invalid');let bytes=0;const chunks=[];
  try{for(;;){bounded.throwIfAborted();const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;if(bytes>8192)fail('relationship_authority_invalid');chunks.push(Buffer.from(p.value));}}finally{await reader.cancel().catch(()=>{});}
  bounded.throwIfAborted();let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{fail('relationship_authority_invalid');}
  const p=value?.provenance;if(value.allowed!==true||value.authorization_request_sha256!==hash(request)||p?.decision_source!=='authenticated_resolution_store'||p.authenticated_store_id!==HISTORY_STORE_ID||p.authenticated_producer_id!==producer||typeof p.policy_version!=='string'||!p.policy_version||!Array.isArray(p.allowed_roles)||!p.allowed_roles.includes('cfo'))fail('relationship_authority_invalid');return value;
 }
 return Object.freeze({authorizeHistory:async(request,options)=>{if(canonical(request.run)!==canonical(run)||request.caller_seat!=='cfo'||request.store_id!==HISTORY_STORE_ID||!['read','write'].includes(request.action))fail('relationship_authority_scope');return requestDecision(request,options);},authorizeArtifact:async request=>{
  if(canonical(request.scope)!==canonical({run,caller_seat:'cfo',producer_id:producer})||!['put','get'].includes(request.action))fail('relationship_authority_scope');
  // Bind the preflight to the exact action, digest and immutable read version.
  return requestDecision(request);
 }});
}
