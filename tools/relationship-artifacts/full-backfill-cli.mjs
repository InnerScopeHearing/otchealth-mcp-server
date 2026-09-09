import {readFile,stat,mkdir,open,unlink} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPublicKey,randomUUID} from 'node:crypto';
import {runRelationshipCatalogScheduler} from './catalog-scheduler.mjs';
import {createGatewayRelationshipStore} from './gateway-store.mjs';
import {createReviewHistoryAuthority,HISTORY_STORE_ID} from './review-history-authority.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
async function jsonFile(path){const s=await stat(path);if(!s.isFile()||s.size>16384)fail('configuration');return JSON.parse(await readFile(path,'utf8'));}
function options(argv){const out={mode:'once',modeSet:false,configPath:null,controller:[]};for(let i=0;i<argv.length;i++){const arg=argv[i];if(['--check','--once','--watch','--recover'].includes(arg)){if(out.modeSet)fail('arguments');out.mode=arg.slice(2);out.modeSet=true;}else if(arg==='--config'){if(out.configPath||!argv[++i])fail('arguments');out.configPath=argv[i];}else if(['--max-admissions','--max-runtime-ms','--poll-ms'].includes(arg)){if(!argv[++i])fail('arguments');out.controller.push(arg,argv[i]);}else fail('arguments');}if(!out.configPath)fail('arguments');return out;}
async function composition(config,env,stdout){
 if(!exact(config,['schema','cto_root','host_config','outbox_directory','producer','registry','review_mode'])||config.schema!=='relationship-backfill-runtime-v1'||!['cto_root','host_config','outbox_directory'].every(k=>typeof config[k]==='string'&&isAbsolute(config[k]))||!/^[a-z][a-z0-9-]{0,63}$/.test(config.producer??''))fail('configuration');
 const candidateOnly=config.review_mode==='candidate-only';if(!candidateOnly&&config.review_mode!=='signed-review')fail('review_mode');const r=config.registry;if(candidateOnly?r!==null:(!exact(r,['id','version','public_key_file','authority'])||typeof r.id!=='string'||!r.id||typeof r.version!=='string'||!r.version||typeof r.public_key_file!=='string'||!isAbsolute(r.public_key_file)))fail('registry_configuration');
 const paths=['catalog-controller/controller-cli.mjs',candidateOnly?'subscription-review/candidate-only.mjs':'subscription-review/candidates.mjs',candidateOnly?null:'subscription-review/registry.mjs',candidateOnly?null:'source-identity-registry/gateway-client.mjs','relationship-adapters/s3-resolution-store.mjs','relationship-adapters/prepared-source.mjs','relationship-resolution/resolver.mjs','source/source-bridge.mjs','subscription-jobs/broker-client.mjs','subscription-jobs/operation-store.mjs','catalog-controller/host.mjs'];
 const modules=[];for(const p of paths){if(p===null){modules.push(null);continue;}const file=join(config.cto_root,'tools/neptune-trial',p);if(!(await stat(file)).isFile())fail('component_missing');modules.push(await import(pathToFileURL(file).href));}
 const [cli,review,registry,registryClient,store,prepared,resolver,source,broker,operations,hostModule]=modules;
 let publicKey;if(!candidateOnly){const keyInfo=await stat(r.public_key_file);if(!keyInfo.isFile()||keyInfo.size>8192)fail('registry_configuration');publicKey=await readFile(r.public_key_file,'utf8');if(createPublicKey(publicKey).asymmetricKeyType!=='ed25519')fail('registry_configuration');}
 const host=hostModule.validateHostConfig(await jsonFile(config.host_config));if(host?.schema!=='company-catalog-controller-host-v1'||host.seat!=='cfo'||!isAbsolute(host.binary)||!(await stat(host.binary)).isFile()||!/^[a-z][a-z0-9-]{0,63}$/.test(host.cohort_id??''))fail('host_configuration');
 // Construct every real dependency locally before allowing the controller to run.
 const bearerTokenProvider=()=>{const value=env.CODEX_CFO_MCP_TOKEN;if(typeof value!=='string'||! /^[\x21-\x7e]{16,8192}$/.test(value))fail('credential_missing');return value;};
 const getAuthorization=()=>`Bearer ${bearerTokenProvider()}`;
 const client=candidateOnly?null:registryClient.createGatewayIdentityRegistryClient({registryId:r.id,authority:r.authority,callerSeat:'cfo',bearerTokenProvider});
 const signedRegistry=candidateOnly?null:registry.createSignedIdentityRegistry({publicKey,registryId:r.id,version:r.version,readSnapshot:client.readSnapshot});
 const historyTrust={store_id:HISTORY_STORE_ID,producer_ids:[config.producer]},sse={algorithm:'AES256'};
 const factories={createResolver:resolver.createResolver,bindPreparedSource:resolver.bindPreparedSource,verificationRequestHash:resolver.verificationRequestHash};
 const reviewOptionsForRun=async run=>{
  const worker=broker.createGatewayBrokerClient({seat:'cfo',run,bearerTokenProvider});
  const authority=createReviewHistoryAuthority({run,producer:config.producer,getAuthorization});
  const artifacts=createGatewayRelationshipStore({createS3ResolutionStore:store.createS3ResolutionStore,gatewayOrigin:'https://mcp.otchealth.app',run,producer:config.producer,authorizeArtifact:authority.authorizeArtifact,getAuthorization,fetchImpl:globalThis.fetch,sse,historyTrust});
  const resolution={run,callerSeat:'cfo',store:artifacts,sourceAdapter:prepared.createPreparedRelationshipSource({broker:worker,run,sourceSnapshots:source.createS3SourceSnapshots({...worker.sourceConfig,signRequest:worker.signRequest,fetchImpl:worker.fetchImpl,allowedRooms:[run.scope]}),callerSeat:'cfo'}),authorizeHistory:authority.authorizeHistory,recordedAt:()=>new Date().toISOString(),historyTrust};return candidateOnly?{resolution}:{resolution,operationStore:operations.createS3SubscriptionOperationStore({...worker.stateConfig,signRequest:worker.signRequest,fetchImpl:worker.fetchImpl}),registry:signedRegistry,binary:host.binary,env};
 };
 return{runCatalogControllerCli:cli.runCatalogControllerCli,createSubscriptionCandidateReview:candidateOnly?review.createCandidateOnlyReview:review.createSubscriptionCandidateReview,factories,reviewOptionsForRun,outboxDirectory:config.outbox_directory,publisherOptions:{gatewayOrigin:'https://mcp.otchealth.app',cohortId:host.cohort_id,producer:config.producer,historyTrust,sse,getAuthorization,fetchImpl:globalThis.fetch},env,stdout,onMonitor:async item=>stdout.write(JSON.stringify(item)+'\n'),checkCredential:bearerTokenProvider,checkRegistry:async()=>{if(!candidateOnly)await signedRegistry.lookup({source_binding:{source_document_version:'readiness-probe',chunk_sha256:'0'.repeat(64)},mention:'readiness-probe'});}};
}
export async function runFullBackfillCli({argv=process.argv.slice(2),env=process.env,stdout=process.stdout,stderr=process.stderr}={}){
 try{
  const args=options(argv),config=await jsonFile(resolve(args.configPath)),runtime=await composition(config,env,stdout);
  // Local checks are deliberately distinct from production readiness.
  if(args.mode==='check'){stdout.write(JSON.stringify({schema:'relationship-launcher-status-v1',status:'configured',review_mode:config.review_mode,processing:'relationships',live_verified:false})+'\n');return 0;}
  runtime.checkCredential();await runtime.checkRegistry();await mkdir(config.outbox_directory,{recursive:true});const probe=join(config.outbox_directory,'.probe-'+randomUUID());const handle=await open(probe,'wx',0o600);try{await handle.writeFile('');await handle.sync();}finally{await handle.close();await unlink(probe);}
  stdout.write(JSON.stringify({schema:'relationship-launcher-status-v1',status:'starting',review_mode:config.review_mode,processing:'relationships',live_verified:false})+'\n');
  const results=await runRelationshipCatalogScheduler({...runtime,argv:['--'+args.mode,'--config',config.host_config,...args.controller]});
  const stop=results.at(-1)?.stop;return ['once_complete','recovery_complete','admission_limit'].includes(stop)?0:stop==='disabled'?2:1;
 }catch(error){const reason=['host_configuration','catalog_gateway_response_invalid','catalog_gateway_configuration','paged_recall_configuration','relationship_scheduler_configuration','relationship_scheduler_cohort','outbox_configuration','host_relationship_result_invalid','catalog_controller_configuration','host_configuration','host_run_configuration','relationship_pipeline_configuration'].includes(error?.code??error?.message)?(error.code??error.message):'dependency_unavailable';stderr.write(JSON.stringify({schema:'relationship-launcher-status-v1',status:'not-ready',reason,processing:'relationships',live_verified:false})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runFullBackfillCli();
