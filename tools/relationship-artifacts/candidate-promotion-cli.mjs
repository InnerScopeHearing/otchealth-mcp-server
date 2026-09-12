import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCfoProjectBearerTokenProvider } from './cfo-project-credential.mjs';

const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(v,k)=>!!v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('\0')===[...k].sort().join('\0');
const target=v=>exact(v,['source_document_version','catalog_source_sha256'])&&/^docv_[a-f0-9]{64}$/.test(v.source_document_version||'')&&HASH.test(v.catalog_source_sha256||'');
async function readJson(path){const info=await stat(path);if(!info.isFile()||info.size>16384)fail('candidate_promotion_cli_config');try{return JSON.parse(await readFile(path,'utf8'));}catch{fail('candidate_promotion_cli_config');}}
function args(argv){if(argv.length!==2||argv[0]!=='--config'||!argv[1])fail('candidate_promotion_cli_arguments');return{configPath:argv[1]};}
function config(v){if(!exact(v,['schema','cto_root','host_config','cfo_project_config','target','extractor_model'])||v.schema!=='candidate-promotion-runtime-v1'||![v.cto_root,v.host_config,v.cfo_project_config].every(isAbsolute)||!target(v.target)||!['gpt-5.6-luna','gpt-5.6-terra'].includes(v.extractor_model))fail('candidate_promotion_cli_config');return structuredClone(v);}
function receipt(proposal){if(!proposal||!HASH.test(proposal.key||'')||!/^run_[a-f0-9]{64}$/.test(proposal.run?.run_id||'')||!HASH.test(proposal.manifest?.manifest_sha256||''))fail('candidate_promotion_cli_result');return Object.freeze({schema:'candidate-promotion-cli-receipt-v1',event:'target_prepared',key:proposal.key,run_id:proposal.run.run_id,manifest_sha256:proposal.manifest.manifest_sha256});}

/** Prepares one exact promotion source through the authenticated catalog route. This mode has
 * no admission, worker, model, review, publication, cursor, or parent-artifact mutation. */
export async function preparePromotionTarget({config:raw,env=process.env,prepareTarget}={}){
 const local=config(raw);
 if(typeof prepareTarget==='function')return receipt(await prepareTarget(local.target,{config:local,env}));
 const [{createCatalogGatewayClient},{validateHostConfig}]=await Promise.all([
  import(pathToFileURL(join(local.cto_root,'tools/neptune-trial/catalog-controller/gateway-client.mjs')).href),
  import(pathToFileURL(join(local.cto_root,'tools/neptune-trial/catalog-controller/host.mjs')).href),
 ]);
 const host=validateHostConfig(await readJson(local.host_config));
 const bearerTokenProvider=createCfoProjectBearerTokenProvider({configPath:local.cfo_project_config});
 const client=createCatalogGatewayClient({cohort_id:host.cohort_id,seat:'cfo',bearerTokenProvider});
 const controller=await client.createController({binary:host.binary,environment:env,extractorModel:local.extractor_model});
 return receipt(await controller.prepareTarget(local.target));
}
export async function runCandidatePromotionCli({argv=process.argv.slice(2),env=process.env,stdout=process.stdout,stderr=process.stderr,load=readJson,prepareTarget}={}){
 try{const {configPath}=args(argv),local=config(await load(resolve(configPath)));const result=await preparePromotionTarget({config:local,env,prepareTarget});stdout.write(JSON.stringify(result)+'\n');return 0;}
 catch(error){const reason=['candidate_promotion_cli_arguments','candidate_promotion_cli_config','candidate_promotion_cli_result','catalog_gateway_not_authorized','catalog_cohort_disabled','catalog_gateway_response_invalid','catalog_gateway_read_unknown','controller_target_missing','controller_target_invalid'].includes(error?.code)?error.code:'candidate_promotion_cli_unavailable';stderr.write(JSON.stringify({schema:'candidate-promotion-cli-receipt-v1',event:'not_ready',reason})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runCandidatePromotionCli();
