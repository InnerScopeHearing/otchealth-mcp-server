import { createHash, randomUUID } from 'node:crypto';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';
import { DaytonaBrowserError, daytonaPhysicalProfileKey, type DaytonaBinding } from './contract.js';
import { assertDaytonaBinding } from './store.js';
import { daytonaViewerPhysicalScopeHash } from './viewer-grant-store.js';

const ROLES=['cto','cfo','clo','coo','cro','developer','wefunder-campaign-director'] as const;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const MASTER='/otchealth/integrations/daytona/company-keyring-unlock-secret';
const HELPER='/opt/otchealth-browser/role-browser-helper.py';
const HELPER_SHA256='e39a1e0f9df08ec6db68fea1d696eb6f860cd08878e062be562b463541c1a529';
const IDLE=600000, GRACE=180000, MONTHLY_WEIGHTED_MS=3100*3600000;
type Roles=Readonly<Record<string,{sandboxId:string;readinessReceiptSha256:string}>>;
type Launch={sessionId:string;commandId:string};
export interface LifecycleRecord {
 version:1;revision:number;role:string;sandboxId:string;binding:DaytonaBinding;
 phase:'WAKING'|'READY'|'DRAINING'|'STOPPED'|'UNKNOWN';operationId:string;
 jobs:string[];lastWork:number;coveredUntil:number;launch?:Launch;
}
export interface LifecycleStore {
 load(sandboxId:string):Promise<LifecycleRecord|null>;
 cas(before:LifecycleRecord|null,after:LifecycleRecord):Promise<boolean>;
 idleFencesClear(binding:DaytonaBinding):Promise<boolean>;
 reserveCost?(role:string,weightedMilliseconds:number,now:number):Promise<void>;
}
export interface LifecyclePlatform {
 wake(binding:DaytonaBinding,operationId:string):Promise<Launch>;
 isReady(binding:DaytonaBinding):Promise<boolean>;
 closeAndStop(binding:DaytonaBinding,operationId:string,launch?:Launch):Promise<void>;
}
export interface DaytonaRoleLifecycle {
 withReady<T>(binding:DaytonaBinding,run:()=>Promise<T>,options?:{maxSeconds?:number}):Promise<T>;
 touch(binding:DaytonaBinding):Promise<void>;
 tick():Promise<void>;
 shutdown():void;
}
function fail(code='daytona_role_lifecycle_unavailable'):never {throw new DaytonaBrowserError(code);}
function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))return fail();return value as Record<string,unknown>;}
function hash(value:string):string{return createHash('sha256').update(value).digest('hex');}
function same(a:unknown,b:unknown):boolean{const left=object(a),right=object(b);return Object.keys(left).length===Object.keys(right).length&&Object.keys(left).every(key=>left[key]===right[key]);}

/** Durable admission remains held across enrollment/probe/openMission. No job or
 * unknown effect is reclaimed by elapsed time. No constructor/provider effects. */
export class DaytonaRoleLifecycleManager implements DaytonaRoleLifecycle {
 private closed=false;private ticking=false;private lastTick=-Infinity;
 private readonly now:()=>number;
 constructor(private readonly options:{store:LifecycleStore;platform:LifecyclePlatform;roles:Roles;now?:()=>number;onError?:(code:string)=>void}) {this.now=options.now??Date.now;}
 private binding(binding:DaytonaBinding):void {
  assertDaytonaBinding(binding);const role=this.options.roles[binding.owner];
  if(this.closed||!role||role.sandboxId!==binding.sandboxId||role.readinessReceiptSha256!==binding.readinessReceiptSha256)return fail('daytona_role_binding_forbidden');
 }
 private async replace(before:LifecycleRecord|null,after:LifecycleRecord):Promise<void>{if(!await this.options.store.cas(before,after))fail('daytona_role_operation_busy');}
 private async reserve(binding:DaytonaBinding,before:LifecycleRecord|null,maxSeconds:number):Promise<number>{
  const until=this.now()+maxSeconds*1000+GRACE+IDLE;
  const gap=Math.max(0,until-Math.max(this.now(),before?.coveredUntil??0));
  if(gap)await this.options.store.reserveCost?.(binding.owner,gap*(binding.owner==='developer'?2:1),this.now());return Math.max(before?.coveredUntil??0,until);
 }
 async withReady<T>(binding:DaytonaBinding,run:()=>Promise<T>,options:{maxSeconds?:number}={}):Promise<T>{
  this.binding(binding);const seconds=options.maxSeconds??60;
  if(!Number.isSafeInteger(seconds)||seconds<1||seconds>28800)fail('daytona_role_duration_invalid');
  const store=this.options.store,before=await store.load(binding.sandboxId);if(before&&!same(before.binding,binding))fail('daytona_role_binding_conflict');
  if(before&&before.phase!=='READY'&&before.phase!=='STOPPED')fail('daytona_role_reconciliation_required');
  const warm=before?.phase==='READY'&&await this.options.platform.isReady(binding);
  if(before?.jobs.length&&!warm)fail('daytona_role_operation_busy');
  const job=randomUUID(),op=randomUUID();const coveredUntil=await this.reserve(binding,before,seconds);
  let current:LifecycleRecord={version:1,revision:(before?.revision??0)+1,role:binding.owner,sandboxId:binding.sandboxId,binding:structuredClone(binding),phase:warm?'READY':'WAKING',operationId:op,jobs:[...(before?.jobs??[]),job],lastWork:this.now(),coveredUntil,...(before?.launch?{launch:before.launch}:{})};
  if(current.jobs.length>64)fail('daytona_role_operation_busy');await this.replace(before,current);
  try {
   if(current.phase==='WAKING'){
    const launch=await this.options.platform.wake(binding,op);
    const after={...current,revision:current.revision+1,phase:'READY' as const,launch};await this.replace(current,after);current=after;
   }
   return await run();
  }catch(error){
   if(current.phase==='WAKING'){
    try{await this.replace(current,{...current,revision:current.revision+1,phase:'UNKNOWN'});}catch{/* durable WAKING remains fenced */}
    fail('daytona_role_reconciliation_required');
   }
   throw error;
  }finally{
   // Exact job only; another replica's job/unknown phase is never removed.
   for(let i=0;i<4;i++){
    const latest=await store.load(binding.sandboxId);if(!latest||latest.phase!=='READY'||!latest.jobs.includes(job))break;
    const after={...latest,revision:latest.revision+1,jobs:latest.jobs.filter(id=>id!==job),lastWork:this.now()};
    if(await store.cas(latest,after))break;if(i===3)fail('daytona_role_admission_release_unknown');
   }
  }
 }
 async touch(binding:DaytonaBinding):Promise<void>{
  this.binding(binding);for(let i=0;i<4;i++){const before=await this.options.store.load(binding.sandboxId);if(!before||before.phase!=='READY'||!same(before.binding,binding))return;
   if(await this.options.store.cas(before,{...before,revision:before.revision+1,lastWork:this.now()}))return;}fail('daytona_role_operation_busy');
 }
 async tick():Promise<void>{
  if(this.closed||this.ticking||this.now()-this.lastTick<30000)return;this.ticking=true;this.lastTick=this.now();
  try{await Promise.all(Object.values(this.options.roles).map(async role=>{
   try{
    let before=await this.options.store.load(role.sandboxId);if(!before||before.phase==='STOPPED')return;
    this.binding(before.binding);
    // Retained unknown/active work is never killed for budget reasons. Account
    // for its continued running time and reject future admissions when capped.
    if(before.coveredUntil<this.now()+30000){
     const until=this.now()+60000,gap=until-before.coveredUntil;
     try{
      await this.options.store.reserveCost?.(before.role,gap*(before.role==='developer'?2:1),this.now());
      const funded={...before,revision:before.revision+1,coveredUntil:until};
      if(!await this.options.store.cas(before,funded))return;before=funded;
     }catch{this.options.onError?.('daytona_role_budget_reconciliation_required');}
     // An exhausted budget must NOT prevent stopping a confirmed idle role.
    }
    if(before.phase!=='READY'||before.jobs.length)return;
    if(this.now()-before.lastWork<IDLE)return;
    if(!await this.options.store.idleFencesClear(before.binding))return;
    const closing={...before,revision:before.revision+1,phase:'DRAINING' as const,operationId:randomUUID()};
    if(!await this.options.store.cas(before,closing))return;
    try{
     // New jobs cannot enter DRAINING. Recheck durable scopes AFTER the CAS.
     if(!await this.options.store.idleFencesClear(closing.binding)){
      await this.replace(closing,{...closing,revision:closing.revision+1,phase:'READY',lastWork:this.now()});return;
     }
     await this.options.platform.closeAndStop(closing.binding,closing.operationId,closing.launch);
     await this.replace(closing,{...closing,revision:closing.revision+1,phase:'STOPPED',jobs:[],lastWork:this.now()});
    }catch{try{await this.replace(closing,{...closing,revision:closing.revision+1,phase:'UNKNOWN'});}catch{/* retain DRAINING */}fail('daytona_role_reconciliation_required');}
   }catch{this.options.onError?.('daytona_role_idle_reconciliation_required');}
  }));}finally{this.ticking=false;}
 }
 shutdown():void{this.closed=true;}
}

type AwsOptions={tableName:string;grantTable:string;region:string;fetchImpl:typeof fetch;resolveCredentials:()=>Promise<AwsCredentials|null>};
class Conflict extends Error{}
async function boundedJson(response:Response):Promise<Record<string,unknown>>{
 if(!response.body)return {};const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>131072){await reader.cancel();fail();}chunks.push(next.value);}}finally{reader.releaseLock();}
 if(!bytes)return {};try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return fail();}
}
async function aws(options:AwsOptions,service:'ssm'|'dynamodb',operation:string,payload:Record<string,unknown>):Promise<Record<string,unknown>>{
 try{
  const credentials=await options.resolveCredentials();if(!credentials)return fail();const host=`${service}.${options.region}.amazonaws.com`,body=JSON.stringify(payload);
  const signed=signRequest({method:'POST',host,path:'/',body,region:options.region,service,credentials,extraHeaders:{'content-type':`application/x-amz-json-${service==='ssm'?'1.1':'1.0'}`,'x-amz-target':`${service==='ssm'?'AmazonSSM':'DynamoDB_20120810'}.${operation}`}});
  const response=await options.fetchImpl(`https://${host}/`,{method:'POST',headers:signed.headers,body,signal:AbortSignal.timeout(5000),redirect:'error'});const result=await boundedJson(response);
  if(!response.ok){if(typeof result.__type==='string'&&result.__type.endsWith('ConditionalCheckFailedException'))throw new Conflict();fail();}return result;
 }catch(error){if(error instanceof Conflict||error instanceof DaytonaBrowserError)throw error;return fail();}
}
/** Separate permanent namespace. NO TTL on lifecycle/job/unknown receipts. */
export class DynamoDaytonaLifecycleStore implements LifecycleStore {
 constructor(private readonly options:AwsOptions){}
 private pk(sandboxId:string):string{if(!UUID.test(sandboxId))return fail();return `DAYTONA#LIFECYCLE#${sandboxId}`;}
 private async item(pk:string,table=this.options.tableName):Promise<Record<string,unknown>|null>{const value=await aws(this.options,'dynamodb','GetItem',{TableName:table,Key:{pk:{S:pk}},ConsistentRead:true});return value.Item===undefined?null:object(value.Item);}
 async load(sandboxId:string):Promise<LifecycleRecord|null>{
  const item=await this.item(this.pk(sandboxId));if(!item)return null;const text=object(item.payload).S;if(typeof text!=='string')return fail();
  let value:LifecycleRecord;try{value=JSON.parse(text) as LifecycleRecord;}catch{return fail();}
  assertDaytonaBinding(value.binding);
  if(value.version!==1||value.sandboxId!==sandboxId||value.binding.sandboxId!==sandboxId||value.binding.owner!==value.role||!Number.isSafeInteger(value.revision)||value.revision<1||!UUID.test(value.operationId)||!Array.isArray(value.jobs)||value.jobs.length>64||!value.jobs.every(id=>UUID.test(id))||new Set(value.jobs).size!==value.jobs.length||!['WAKING','READY','DRAINING','STOPPED','UNKNOWN'].includes(value.phase)||!Number.isSafeInteger(value.lastWork)||!Number.isSafeInteger(value.coveredUntil))return fail();return value;
 }
 async cas(before:LifecycleRecord|null,after:LifecycleRecord):Promise<boolean>{
  const pk=this.pk(after.sandboxId);try{await aws(this.options,'dynamodb','PutItem',{TableName:this.options.tableName,Item:{pk:{S:pk},revision:{N:String(after.revision)},payload:{S:JSON.stringify(after)}},ConditionExpression:before?'revision = :old':'attribute_not_exists(pk)',...(before?{ExpressionAttributeValues:{':old':{N:String(before.revision)}}}:{})});return true;}catch(error){if(error instanceof Conflict)return false;throw error;}
 }
 async idleFencesClear(binding:DaytonaBinding):Promise<boolean>{
  const keys=[`DAYTONA#LEASE#${binding.profileKey}`,`DAYTONA#LEASE#display-${hash(binding.sandboxId).slice(0,40)}`];
  for(const pk of keys)if(await this.item(pk))return false;
  return !await this.item(`DAYTONA#VIEWER_SCOPE#${daytonaViewerPhysicalScopeHash('501db94e-10ee-4bc8-9cca-23c793c67524',binding.sandboxId)}`,this.options.grantTable);
 }
 async reserveCost(_role:string,weightedMilliseconds:number,now:number):Promise<void>{
  const amount=Math.ceil(weightedMilliseconds);if(!Number.isSafeInteger(amount)||amount<1||amount>MONTHLY_WEIGHTED_MS)fail('daytona_budget_exhausted');
  const month=new Date(now).toISOString().slice(0,7);try{
   await aws(this.options,'dynamodb','UpdateItem',{TableName:this.options.tableName,Key:{pk:{S:`DAYTONA#LIFECYCLE_BUDGET#${month}`}},UpdateExpression:'SET weightedMs = if_not_exists(weightedMs, :zero) + :amount',ConditionExpression:'attribute_not_exists(weightedMs) OR weightedMs <= :remaining',ExpressionAttributeValues:{':zero':{N:'0'},':amount':{N:String(amount)},':remaining':{N:String(MONTHLY_WEIGHTED_MS-amount)}}});
  }catch(error){if(error instanceof Conflict)fail('daytona_budget_exhausted');throw error;}
 }
}

interface PlatformOptions extends AwsOptions {apiBaseUrl:string;organizationId:string;origins:readonly string[];helperSha256:string;resolveApiToken:()=>Promise<string>;}
/** Official0.224.1 REST wire; zero provider retries. Only bounded read-only polling. */
export class RestDaytonaLifecyclePlatform implements LifecyclePlatform {
 private readonly base:URL;private readonly origins:Set<string>;
 constructor(private readonly options:PlatformOptions){this.base=trustedUrl(options.apiBaseUrl);this.base.pathname=this.base.pathname.replace(/\/+$/,'');this.origins=new Set(options.origins);}
 private async request(url:string,method='GET',body?:unknown,timeoutMs=method==='GET'?10000:25000):Promise<Record<string,unknown>>{
  const token=await this.options.resolveApiToken();if(typeof token!=='string'||!/^[\x21-\x7e]{16,8192}$/.test(token))return fail();
  try{const response=await this.options.fetchImpl(url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','X-Daytona-SDK-Version':'0.224.1','X-Daytona-Organization-ID':this.options.organizationId},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});if(!response.ok){await response.body?.cancel();return fail();}return await boundedJson(response);}catch{return fail();}
 }
 private api(binding:DaytonaBinding,path=''):string{return `${this.base.href.replace(/\/+$/,'')}/sandbox/${binding.sandboxId}${path}`;}
 private async inspect(binding:DaytonaBinding):Promise<Record<string,unknown>>{const value=await this.request(this.api(binding));if(value.id!==binding.sandboxId||value.organizationId!==this.options.organizationId||value.public!==false||typeof value.state!=='string')return fail('daytona_role_binding_forbidden');return value;}
 private async toolbox(binding:DaytonaBinding):Promise<string>{const proxy=await this.request(this.api(binding,'/toolbox-proxy-url'));if(typeof proxy.url!=='string')return fail();const url=trustedUrl(proxy.url);if(!this.origins.has(url.origin))return fail('daytona_toolbox_origin_forbidden');return `${url.href.replace(/\/+$/,'')}/${binding.sandboxId}`;}
 private command(binding:DaytonaBinding,operationId:string,op:string):string{
  const payload=Buffer.from(JSON.stringify({version:1,op,role:binding.owner,sandboxId:binding.sandboxId,profileKey:daytonaPhysicalProfileKey(binding),operationId})).toString('base64url');
  // Hash the installed helper BEFORE executing it, using fixed system Python -I.
  const guard=`import hashlib,os,stat; p='${HELPER}'; f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW); s=os.fstat(f); assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==493; assert hashlib.sha256(os.read(f,131072)).hexdigest()=='${this.options.helperSha256}'; os.close(f); os.execv('/usr/bin/python3',['python3','-I','-B',p,'--payload','${payload}'])`;
  return `sudo -n /usr/bin/python3 -I -B -c ${shell(guard)}`;
 }
 private async execute(base:string,command:string,timeout=15):Promise<Record<string,unknown>>{
  const receipt=await this.request(`${base}/process/execute`,'POST',{command,timeout},(timeout+5)*1000);
  if((receipt.exitCode??receipt.code)!==0||typeof receipt.result!=='string'||receipt.result.length>100000)return fail('daytona_role_runtime_unavailable');
  try{return object(JSON.parse(receipt.result));}catch{return fail();}
 }
 private async helper(binding:DaytonaBinding,op:string,operationId:string=randomUUID(),base?:string):Promise<Record<string,unknown>>{return this.execute(base??await this.toolbox(binding),this.command(binding,operationId,op),op==='close'?40:15);}
 async isReady(binding:DaytonaBinding):Promise<boolean>{
  const state=await this.inspect(binding);if(state.state!=='started')return false;
  const value=await this.helper(binding,'status');return value.ready===true&&value.profileKey===daytonaPhysicalProfileKey(binding)&&value.profilePath===binding.profilePath&&value.encryptedKeyringUnlocked===true&&value.checkpointReady===true&&value.runtimeProtocol===2;
 }
 private async waitState(binding:DaytonaBinding,state:string):Promise<void>{const until=Date.now()+60000;while(Date.now()<until){if((await this.inspect(binding)).state===state)return;await delay(500);}fail('daytona_role_transition_unknown');}
 async wake(binding:DaytonaBinding,operationId:string):Promise<Launch>{
  const state=await this.inspect(binding);
  if(state.state==='stopped'){await this.request(this.api(binding,'/start'),'POST');await this.waitState(binding,'started');}
  else if(state.state!=='started')return fail('daytona_role_transition_unknown');
  // Active jobs are never exposed to a preview-inactivity timer.
  await this.request(this.api(binding,'/autostop/0'),'POST');
  const base=await this.toolbox(binding);
  if(await this.isReady(binding))return {sessionId:'adopted-owned-runtime',commandId:'adopted-owned-runtime'};
  // computerUse.start is the vendor's fixed idempotent desktop-start recipe.
  await this.request(`${base}/computeruse/start`,'POST');
  const sessionId=`otc-role-${binding.owner}-${operationId}`,command=this.command(binding,operationId,'launch');
  await this.request(`${base}/process/session`,'POST',{sessionId});
  const launched=await this.request(`${base}/process/session/${sessionId}/exec`,'POST',{command,runAsync:true,suppressInputEcho:true});
  if(typeof launched.cmdId!=='string'||!UUID.test(launched.cmdId))return fail();const commandId=launched.cmdId;
  const path=`${base}/process/session/${sessionId}/command/${commandId}`;
  await this.waitEvent(path,binding,operationId,'receiver_ready',15000);
  const value=await aws(this.options,'ssm','GetParameter',{Name:MASTER,WithDecryption:true});const parameter=object(value.Parameter);
  if(parameter.Name!==MASTER||parameter.Type!=='SecureString'||parameter.Version!==1||typeof parameter.Value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(parameter.Value))return fail('daytona_role_key_unavailable');
  // suppressInputEcho was positively requested on this NEW dedicated session.
  // The only copy sent to the provider is its private TLS stdin endpoint.
  let secret=parameter.Value;delete parameter.Value;
  try{
   const native=await this.helper(binding,'native',operationId,base);if(native.ok!==true||native.nativeZero!==true)return fail('daytona_role_human_active');
   await this.request(`${path}/input`,'POST',{data:`${secret}\n`});
  }finally{secret='';}
  await this.waitEvent(path,binding,operationId,'runtime_ready',30000);
  if(!await this.isReady(binding))return fail('daytona_role_runtime_unavailable');
  const commit=await this.helper(binding,'commit',operationId,base);if(commit.ok!==true||commit.managedVault!==true)return fail();return {sessionId,commandId};
 }
 private async waitEvent(path:string,binding:DaytonaBinding,operationId:string,event:string,timeout:number):Promise<void>{
  const until=Date.now()+timeout;
  while(Date.now()<until){
   const metadata=await this.request(path);if(metadata.exitCode!==null&&metadata.exitCode!==undefined)return fail('daytona_role_startup_failed');
   const logs=await this.request(`${path}/logs`);if(typeof logs.stdout!=='string'||logs.stdout.length>100000)return fail();
   const events=logs.stdout.split('\n').filter(line=>line.startsWith('OTC_ROLE_EVENT=')).map(line=>object(JSON.parse(line.slice(15))));
   if(events.some(value=>value.event==='failure'))return fail('daytona_role_startup_failed');
   if(events.some(value=>value.event===event&&value.role===binding.owner&&value.sandboxId===binding.sandboxId&&value.operationId===operationId))return;
   await delay(500);
  }return fail('daytona_role_startup_unknown');
 }
 async closeAndStop(binding:DaytonaBinding,operationId:string,launch?:Launch):Promise<void>{
  if((await this.inspect(binding)).state!=='started')return fail('daytona_role_transition_unknown');
  const base=await this.toolbox(binding),closed=await this.helper(binding,'close',operationId,base);
  if(closed.ok!==true||closed.browserClosed!==true||closed.supervisorExited!==true||closed.writerLocksFree!==true||closed.encryptedVaultPreserved!==true)return fail('daytona_role_stop_unknown');
  if(launch&&launch.sessionId!=='adopted-owned-runtime'){
   const path=`${base}/process/session/${encodeURIComponent(launch.sessionId)}/command/${encodeURIComponent(launch.commandId)}`,until=Date.now()+15000;
   let ended=false;while(Date.now()<until){const value=await this.request(path);if(value.exitCode===0){ended=true;break;}if(value.exitCode!==null&&value.exitCode!==undefined)return fail('daytona_role_stop_unknown');await delay(200);}if(!ended)return fail('daytona_role_stop_unknown');
  }
  await this.request(this.api(binding,'/stop?force=false'),'POST');await this.waitState(binding,'stopped');
 }
}
function shell(value:string):string{return `'${value.replace(/'/g,`'"'"'`)}'`;}
function trustedUrl(value:string):URL{let url:URL;try{url=new URL(value);}catch{return fail('daytona_role_configuration_invalid');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port)return fail('daytona_role_configuration_invalid');return url;}
function delay(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}

export function createConfiguredDaytonaRoleLifecycle(options:{env?:NodeJS.ProcessEnv;resolveApiToken:()=>Promise<string>;fetchImpl?:typeof fetch;resolveCredentials?:()=>Promise<AwsCredentials|null>}):DaytonaRoleLifecycle|undefined{
 const env=options.env??process.env;if(env.DAYTONA_AGENT_DESKTOP_TEMPLATES===undefined)return undefined;
 try{
  const config=object(JSON.parse(env.DAYTONA_AGENT_DESKTOP_TEMPLATES));if(config.schema!=='daytona-agent-desktops/v1'||Object.keys(config).sort().join(',')!=='agents,schema')return fail('daytona_role_configuration_invalid');
  const agents=object(config.agents);if(Object.keys(agents).sort().join(',')!==[...ROLES].sort().join(','))return fail('daytona_role_configuration_invalid');
  const roles:Record<string,{sandboxId:string;readinessReceiptSha256:string}>={};
  for(const role of ROLES){const item=object(agents[role]);if(Object.keys(item).sort().join(',')!=='readinessReceiptSha256,sandboxId'||typeof item.sandboxId!=='string'||!UUID.test(item.sandboxId)||typeof item.readinessReceiptSha256!=='string'||!HASH.test(item.readinessReceiptSha256))return fail('daytona_role_configuration_invalid');roles[role]={sandboxId:item.sandboxId,readinessReceiptSha256:item.readinessReceiptSha256};}
  if(new Set(Object.values(roles).map(role=>role.sandboxId)).size!==7)return fail('daytona_role_configuration_invalid');
  const tableName=env.DAYTONA_BROWSER_DDB_TABLE??env.CLOUD_BROWSER_DDB_TABLE??'',grantTable=env.DAYTONA_VIEWER_GRANT_DDB_TABLE??tableName,region=env.AWS_REGION??'us-east-1';
  const helperSha256=HELPER_SHA256;if(env.DAYTONA_ROLE_LIFECYCLE_HELPER_SHA256!==undefined&&env.DAYTONA_ROLE_LIFECYCLE_HELPER_SHA256!==helperSha256||!/^[-A-Za-z0-9_.]{3,255}$/.test(tableName)||!/^[-A-Za-z0-9_.]{3,255}$/.test(grantTable)||region!=='us-east-1'||env.DAYTONA_BROWSER_ORGANIZATION_ID!=='501db94e-10ee-4bc8-9cca-23c793c67524')return fail('daytona_role_configuration_invalid');
  const originsValue:unknown=JSON.parse(env.DAYTONA_BROWSER_TOOLBOX_ALLOWED_ORIGINS??'null');if(!Array.isArray(originsValue)||!originsValue.length||originsValue.length>4||!originsValue.every(value=>typeof value==='string'&&trustedUrl(value).origin===value))return fail('daytona_role_configuration_invalid');
  const shared={tableName,grantTable,region,fetchImpl:options.fetchImpl??fetch,resolveCredentials:options.resolveCredentials??resolveAwsCredentials};
  return new DaytonaRoleLifecycleManager({roles,store:new DynamoDaytonaLifecycleStore(shared),platform:new RestDaytonaLifecyclePlatform({...shared,apiBaseUrl:env.DAYTONA_BROWSER_API_BASE_URL??'',organizationId:env.DAYTONA_BROWSER_ORGANIZATION_ID,origins:originsValue as string[],helperSha256,resolveApiToken:options.resolveApiToken})});
 }catch(error){if(error instanceof DaytonaBrowserError)throw error;return fail('daytona_role_configuration_invalid');}
}
