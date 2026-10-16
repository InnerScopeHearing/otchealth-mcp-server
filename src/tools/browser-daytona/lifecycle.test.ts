import test from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaRoleLifecycleManager, RestDaytonaLifecyclePlatform, createConfiguredDaytonaRoleLifecycle, type LifecycleRecord, type LifecycleStore, type LifecyclePlatform } from './lifecycle.js';
import type { DaytonaBinding } from './contract.js';

const binding: DaytonaBinding = { provider:'daytona',owner:'cto',ownerSubjectHash:'a'.repeat(64),sandboxId:'c8a26ccf-1755-4bd2-83d6-52d5164b2e84',profileKey:`cto-${'a'.repeat(64)}`,sharedProfileKey:'company-browser',profilePath:'/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium',readinessReceiptSha256:'b'.repeat(64) };
function fixture() {
 let now=1000000; let state:LifecycleRecord|null=null; const calls:string[]=[];
 const store:LifecycleStore={load:async()=>structuredClone(state),cas:async(before,after)=>{if(JSON.stringify(before)!==JSON.stringify(state))return false;state=structuredClone(after);return true;},idleFencesClear:async()=>true};
 const platform:LifecyclePlatform={wake:async()=>{calls.push('wake');return {sessionId:'role-session',commandId:'d'.repeat(8)+'-1111-4111-8111-111111111111'};},isReady:async()=>{calls.push('probe');return true;},closeAndStop:async()=>{calls.push('stop');}};
 const manager=new DaytonaRoleLifecycleManager({store,platform,now:()=>now,roles:{cto:{sandboxId:binding.sandboxId,readinessReceiptSha256:binding.readinessReceiptSha256}},onError:()=>{}});
 return {manager,calls,platform,store,get state(){return state;},advance:(ms:number)=>{now+=ms;}};
}
test('durable admission spans wake and callback; warm work does not re-unlock',async()=>{
 const f=fixture();await f.manager.withReady(binding,async()=>{assert.equal(f.state?.jobs.length,1);assert.equal(f.state?.phase,'READY');},{maxSeconds:180});
 assert.equal(f.state?.jobs.length,0);await f.manager.withReady(binding,async()=>42);
 const reordered=Object.fromEntries(Object.entries(binding).reverse()) as unknown as DaytonaBinding;
 await f.manager.withReady(reordered,async()=>43);
 assert.deepEqual(f.calls,['wake','probe','probe']);assert.equal(f.state?.phase,'READY');
});
test('idle tick is real, waits600s and respects durable profile/viewer fences',async()=>{
 const f=fixture();await f.manager.withReady(binding,async()=>{});f.advance(599999);await f.manager.tick();assert.equal(f.calls.includes('stop'),false);
 f.advance(30001);f.store.idleFencesClear=async()=>false;await f.manager.tick();assert.equal(f.calls.includes('stop'),false);
 f.advance(30001);f.store.idleFencesClear=async()=>true;await f.manager.tick();assert.equal(f.state?.phase,'STOPPED');assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
test('unknown wake/close is permanently fenced, never automatically retried',async()=>{
 const f=fixture();f.platform.wake=async()=>{f.calls.push('wake');throw Error('secret must not escape');};
 await assert.rejects(f.manager.withReady(binding,async()=>{}),/owned Daytona/);assert.equal(f.state?.phase,'UNKNOWN');
 await assert.rejects(f.manager.withReady(binding,async()=>{}));f.advance(900000);await f.manager.tick();assert.deepEqual(f.calls,['wake']);
});
test('active job blocks idle; metadata-only touch resets idle clock',async()=>{
 const f=fixture();await f.manager.withReady(binding,async()=>{f.advance(900000);await f.manager.tick();assert.equal(f.calls.includes('stop'),false);});
 f.advance(590000);await f.manager.touch(binding);f.advance(30001);await f.manager.tick();assert.equal(f.calls.includes('stop'),false);assert.deepEqual(f.calls,['wake']);
});
test('budget exhaustion does not prevent confirmed graceful idle stop',async()=>{
 const f=fixture();await f.manager.withReady(binding,async()=>{});f.advance(1000000);
 f.store.reserveCost=async()=>{throw Error('budget exhausted');};await f.manager.tick();assert.equal(f.state?.phase,'STOPPED');assert.equal(f.calls.filter(value=>value==='stop').length,1);
});
test('fresh startup boundary detects stopped warm desktop and wakes once',async()=>{
 const f=fixture();await f.manager.withReady(binding,async()=>{});f.platform.isReady=async()=>false;
 await f.manager.withReady(binding,async()=>{});assert.equal(f.calls.filter(value=>value==='wake').length,2);
});
test('foreign binding, invalid bounds, and shutdown cause no provider effects',async()=>{
 const f=fixture();await assert.rejects(f.manager.withReady({...binding,owner:'cfo'},async()=>{}));await assert.rejects(f.manager.withReady(binding,async()=>{},{maxSeconds:28801}));
 f.manager.shutdown();await assert.rejects(f.manager.withReady(binding,async()=>{}));await f.manager.tick();assert.deepEqual(f.calls,[]);
});
test('factory absent map has no effects; malformed map fails closed',()=>{
 assert.equal(createConfiguredDaytonaRoleLifecycle({env:{},resolveApiToken:async()=>{throw Error();}}),undefined);
 assert.throws(()=>createConfiguredDaytonaRoleLifecycle({env:{DAYTONA_AGENT_DESKTOP_TEMPLATES:'{}'},resolveApiToken:async()=>''}));
});
test('role command pins the updated helper only for WeFunder and preserves the legacy pin for six roles',()=>{
 const oldHash='b99a41492cdfe17f410c55ffd442cbb26a839299e200d669663749b6b57a8e51';
 const wefunderHash='cbd15ea480ccce50d95a32283d90204d1b2aad24ba29454c23c73342c1fe3bed';
 const platform=new RestDaytonaLifecyclePlatform({tableName:'lifecycle',grantTable:'grants',region:'us-east-1',fetchImpl:fetch,resolveCredentials:async()=>null,
  apiBaseUrl:'https://api.daytona.com',organizationId:'501db94e-10ee-4bc8-9cca-23c793c67524',origins:['https://api.daytona.com'],helperSha256:oldHash,resolveApiToken:async()=>''});
 const command=(platform as unknown as {command:(value:DaytonaBinding,id:string,op:string)=>string}).command.bind(platform);
 for(const role of ['cto','cfo','clo','coo','cro','developer'])assert.ok(command({...binding,owner:role},'d'.repeat(8)+'-1111-4111-8111-111111111111','status').includes(oldHash),`${role} retains old helper pin`);
 assert.ok(command({...binding,owner:'wefunder-campaign-director'},'d'.repeat(8)+'-1111-4111-8111-111111111111','status').includes(wefunderHash));
});
