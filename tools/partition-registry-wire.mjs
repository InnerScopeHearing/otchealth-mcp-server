// Actual cross-repository factories, synthetic transports/data only. No AWS calls.
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import Fastify from 'fastify';
import {createIdentityRegistryS3SnapshotStore} from './identity-registry-s3-store.mjs';
for(const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'}))process.env[key]??=value;
const {graphWorkerBrokerTest:helper,registerGraphWorkerBrokerRoutes}=await import('../dist/server/graph-worker-broker.js');
if(!process.argv[2])throw Error('cto_root_required');
const load=p=>import(pathToFileURL(join(resolve(process.argv[2]),'tools/neptune-trial',p)).href);
const [{createSyntheticReview},{createSignedPartitionManifest,createPartitionedSignedIdentityRegistry},{createGatewayPartitionIdentityRegistryClient}]=await Promise.all([
  load('subscription-review/synthetic-fixture.mjs'),load('source-identity-registry/partition-manifest.mjs'),load('source-identity-registry/partition-gateway-client.mjs')]);
const f=createSyntheticReview(),batch=f.batch(),definitions=f.wire.state.definitions.slice(0,3),run=f.wire.state.run;
const H=helper.digest,canonical=helper.canonical,digest=hashes=>H(canonical([...hashes].sort()));
const authority={schema:'authenticated-structured-identity-authority-v1',adapter_id:'synthetic',source_system:'synthetic',scope:'cfo',version:'1'};
const bindingHash=b=>H(canonical({source_document_version:b.source_document_version,source_sha256:b.chunk_sha256}));
const allHashes=definitions.map(d=>bindingHash(d.binding));
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pem=publicKey.export({type:'spki',format:'pem'}),keyHash=H(publicKey.export({type:'spki',format:'der'}));
const objects=new Map();let revision=0;
const store=createIdentityRegistryS3SnapshotStore({bucket:'synthetic-registry-store',prefix:'synthetic/partitions',region:'us-east-1',sse:{algorithm:'AES256'},requestTimeoutMs:1000,
  immutableTombstonePolicyAttested:true,signRequest:async request=>({url:request.url,headers:request.headers}),fetchImpl:async(urlText,init)=>{
    const url=new URL(urlText),stored=objects.get(url.pathname),version=url.searchParams.get('versionId');
    const reply=(body,status,pin)=>new Response(body,{status,headers:pin?{'x-amz-version-id':pin,'x-amz-server-side-encryption':'AES256'}:{}});
    if(init.method==='GET')return stored&&(!version||stored.version===version)?reply(stored.body,200,stored.version):reply('',404);
    if(init.method!=='PUT'||new Headers(init.headers).get('if-none-match')!=='*')return reply('',400);
    if(stored)return reply('',412);const item={body:String(init.body),version:`synthetic-${++revision}`};objects.set(url.pathname,item);return reply('',200,item.version);
  }});
const shards=[],shardEnvelopes=new Map();
for(const prefix of '0123456789abcdef'){
  const selected=definitions.filter(d=>bindingHash(d.binding).startsWith(prefix)),hashes=selected.map(d=>bindingHash(d.binding));
  const snapshot={schema:'source-identity-registry-v1',registry_id:'cfo-registry',version:`shard-${prefix}-v1`,source_authority:authority,source_version:'generation-1',
    public_key_sha256:keyHash,partition_binding_hashes:hashes,entries:selected.flatMap(d=>[d.subject,d.object].map(endpoint=>({
      source_document_version:d.binding.source_document_version,source_sha256:d.binding.chunk_sha256,mention:endpoint.display_name,endpoint}))),revocations:[]};
  const envelope={snapshot,signature:sign(null,Buffer.from(canonical(snapshot)),privateKey).toString('base64')};
  shardEnvelopes.set(`shard-${prefix}`,envelope);
  shards.push({shard_id:`shard-${prefix}`,partition_prefix:prefix,registry_version:snapshot.version,snapshot_sha256:H(canonical(snapshot)),source_version:'generation-1',binding_count:hashes.length,binding_set_sha256:digest(hashes)});
}
const catalogCoverage={schema:'source-identity-catalog-coverage-v1',catalog_version:'synthetic-catalog',coverage_sha256:H('synthetic-catalog'),complete:true,
  expected_shard_count:16,source_binding_count:allHashes.length,source_binding_set_sha256:digest(allHashes)};
const manifest=await createSignedPartitionManifest({registryId:'cfo-registry',sourceAuthority:authority,sourceGeneration:'generation-1',catalogCoverage,shards,
  signer:{publicKey:pem,sign:async({payload})=>sign(null,payload,privateKey).toString('base64')}});
const pin=manifest.snapshot.version;
const binding={authenticated_caller:'cfo',run,room:'finance',source_index:'finance-cfo-source-docs'};
const policy={schema:'graph-worker-bindings-v1',policy_version:'synthetic-partitions',expires_at:'2030-01-01T00:00:00.000Z',bindings:[binding]};
const state={status:'active',run,superseded_run:null,tombstone:null},active={schema:'neptune-trial-active-run-state-v1',state_sha256:H(canonical(state)),state};
const app=Fastify({logger:false});
registerGraphWorkerBrokerRoutes(app,{authenticate:async()=>({caller_hash:H('synthetic'),raw_token:'synthetic',caller_agent:'cfo',connector_surface:true,m365_static_auth:false}),
  bindingsJson:()=>JSON.stringify(policy),now:()=>Date.parse('2026-09-09T00:00:00.000Z'),resolveCohortBinding:async()=>null,
  s3:async request=>request.method==='GET'&&request.key===helper.statePrefix(binding)+'/active-runs/'+helper.bindingHash(run)+'.json'?
    {status:200,headers:new Headers({etag:'"synthetic"'}),body:Buffer.from(canonical(active))}:{status:404,headers:new Headers(),body:Buffer.alloc(0)},
  readCfoText:async()=>{throw Error('partition_routes_must_not_read_source_text');},identityRegistry:{resolve:async({registry_id})=>registry_id==='cfo-registry'?{
    registry_id,authority,binding,public_key:pem,source:{page:async()=>{throw Error('unexpected_single_registry_read');},current:async()=>true},snapshots:store,
    partitions:{manifest_version:pin,read_manifest:async()=>store.read({registry_id,version:pin}),read_shard:async({registry_version})=>store.read({registry_id,version:registry_version}),
      publish_manifest:async({manifest_version,envelope})=>store.publish({registry_id,version:manifest_version,envelope}),
      publish_shard:async({registry_version,envelope})=>store.publish({registry_id,version:registry_version,envelope}),
      manifest_current:async()=>true,shard_current:async()=>true,binding_covered:async({source_binding_hash})=>allHashes.includes(source_binding_hash),
      coverage_page:async()=>({schema:'source-identity-catalog-coverage-page-v1',source_generation:'generation-1',catalog_version:'synthetic-catalog',
        coverage_sha256:catalogCoverage.coverage_sha256,binding_hashes:allHashes,next_cursor:null})}}:null}});
await app.ready();
try{
  const base=`/graph-worker/v1/identity-registry/cfo-registry/partitions/${pin}`;
  const publish=(path,envelope)=>app.inject({method:'PUT',url:path,headers:{authorization:'Bearer synthetic-only','if-none-match':'*'},payload:envelope});
  const published=await publish(base,manifest);assert.ok([200,201].includes(published.statusCode),published.body);
  assert.equal((await publish(base,manifest)).statusCode,412);
  for(const [id,envelope] of shardEnvelopes){const result=await publish(base+'/shards/'+id,envelope);assert.ok([200,201].includes(result.statusCode),result.body);}
  const invalid=await publish(base,{...manifest,signature:'invalid'});assert.ok(invalid.statusCode>=400,invalid.body);
  const mismatch=await publish(base+'/shards/shard-0',shardEnvelopes.get('shard-1'));assert.ok(mismatch.statusCode>=400,mismatch.body);
  const client=createGatewayPartitionIdentityRegistryClient({registryId:'cfo-registry',manifestVersion:pin,authority,callerSeat:'cfo',bearerTokenProvider:()=> 'synthetic-only',
    transport:async(url,init)=>{const u=new URL(url),reply=await app.inject({method:init.method,url:u.pathname+u.search,headers:init.headers,payload:init.body});return new Response(reply.body,{status:reply.statusCode,headers:reply.headers});}});
  const registry=createPartitionedSignedIdentityRegistry({publicKey:pem,registryId:'cfo-registry',version:pin,...client});
  assert.equal((await registry.coverage()).complete,true);
  const receipt=await f.build(registry).review(batch);assert.equal(receipt.results[0].status,'qualified');
  const query={...batch.queries[0],premise_ids:receipt.results[0].premise_ids};
  assert.equal((await f.build(registry).retrieve(receipt.artifact_ref,query)).answer.status,'qualified');
  await store.revoke({registry_id:'cfo-registry',version:`shard-${allHashes[0][0]}-v1`});
  const denied=await f.build(registry).retrieve(receipt.artifact_ref,query);assert.equal(denied.answer.status,'invalidated');assert.equal(denied.answer.conclusion,null);
  await assert.rejects(registry.coverage());
  process.stdout.write(JSON.stringify({synthetic_only:true,real_aws_calls:0,actual_partition_gateway:true,bootstrap_publication:true,duplicate_create_denied:true,
    s3_pinned_snapshots:true,qualified_path:true,revoked_shard_invalidates:true})+'\n');
}finally{await app.close();}
