import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.CIO_SITE_ID='test';process.env.CIO_TRACK_KEY='test';process.env.CIO_APP_API_BEARER='test';process.env.PERPLEXITY_CONNECTOR_TOKEN='p'.repeat(32);process.env.ADMIN_REVOKE_TOKEN='a'.repeat(32);process.env.N8N_WEBHOOK_SECRET='n'.repeat(32);
const { handleChatActionInventory, registerChatActionInventory } = await import('./chat-action-inventory.js');
const { registerTool } = await import('../registry.js');
const { requestContext, currentCallerHash } = await import('../../server/request-context.js');
const id=(ch:string)=>'caj_'+ch.repeat(64);
const row=(ch:string)=>({id:id(ch),status:'queued',action:'checkpoint',caller_agent:'coo',created_at:'2026-11-05T00:00:00.000Z',updated_at:'2026-11-05T00:00:00.000Z'});

test('bounded keyset pagination uses a DB projection and excludes payloads',async()=>{
 let queries=0;const deps:any={query:async (input:any)=>{
  queries++;assert.deepEqual(input,{owner:'coo',after:'',limit:3});
  return [{...row('a'),request:'PRIVATE_SENTINEL',result:'PRIVATE_SENTINEL'},row('b'),row('c')];
 }};
 const out=await handleChatActionInventory({owner:'coo',page_size:2},{callerAgent:'cto'},deps);
 assert.equal(queries,1);assert.equal(out.data.count,2);assert.equal(out.data.next_cursor,id('b'));assert.doesNotMatch(JSON.stringify(out),/PRIVATE_SENTINEL/);
 assert.deepEqual(out.data.jobs,[row('a'),row('b')]);
});

test('CTO-only authorization and company-only lane validation precede database access',async()=>{
 let calls=0;const deps:any={query:async()=>{calls++;return [];}};
 for(const caller of ['coo','clo-personal','unknown','']) await assert.rejects(()=>handleChatActionInventory({owner:'coo'},{callerAgent:caller},deps),/inventory_forbidden/);
 for(const owner of ['clo-personal','external-read','unknown']) await assert.rejects(()=>handleChatActionInventory({owner} as any,{callerAgent:'cto'},deps),/inventory_invalid_input/);
 await assert.rejects(()=>handleChatActionInventory({owner:'coo',cursor:'personal secret'} as any,{callerAgent:'cto'},deps),/inventory_invalid_input/);
 assert.equal(calls,0);
});

test('invalid or mismatched projected records fail closed instead of exposing malformed data',async()=>{
 for(const bad of [{...row('a'),caller_agent:'clo-personal'},{...row('a'),id:'PRIVATE_SENTINEL'},{...row('a'),created_at:'PRIVATE_SENTINEL'},{...row('a'),status:'PRIVATE_SENTINEL'}]){
  const deps:any={query:async()=>[bad]};
  await assert.rejects(()=>handleChatActionInventory({owner:'coo'},{callerAgent:'cto'},deps),/inventory_invalid_record/);
 }
});

test('real registry rejects non-CTO callers before executing inventory',async()=>{
 let handler:any,calls=0;const effects:any={inboundShield:async()=>({ran:false,blocked:false,attackDetected:false,mode:'report'}),logToolStart:()=>{}};
 registerChatActionInventory({registerTool:(_n:any,_c:any,h:any)=>{handler=h;}} as never,currentCallerHash,{query:async()=>{calls++;return [];},register:((s:any,d:any,h:any)=>registerTool(s,d,h,false,effects)) as never});
 const response=await requestContext.run({callerHash:'synthetic',correlationId:'synthetic',callerAgent:'coo'},()=>handler({owner:'coo'}));
 assert.equal(response.isError,true);assert.equal(response.structuredContent.error.code,'inventory_forbidden');assert.equal(calls,0);
});

test('continuation uses the original opaque handle as an exclusive lower bound',async()=>{
 let seen:any;const deps:any={query:async(input:any)=>{seen=input;return [row('c')];}};
 const out=await handleChatActionInventory({owner:'coo',cursor:id('b'),page_size:2},{callerAgent:'cto'},deps);
 assert.equal(seen.after,id('b'));assert.equal(out.data.jobs[0].id,id('c'));assert.equal(out.data.next_cursor,null);
});

test('real registry allows CTO metadata reads and strips extra fields',async()=>{
 let handler:any;const effects:any={inboundShield:async()=>({ran:false,blocked:false,attackDetected:false,mode:'report'}),logToolStart:()=>{}};
 registerChatActionInventory({registerTool:(_n:any,_c:any,h:any)=>{handler=h;}} as never,currentCallerHash,{query:async()=>[{...row('a'),request:'PRIVATE_SENTINEL'}],register:((s:any,d:any,h:any)=>registerTool(s,d,h,false,effects)) as never});
 const response=await requestContext.run({callerHash:'synthetic',correlationId:'synthetic',callerAgent:'cto'},()=>handler({owner:'coo'}));
 assert.notEqual(response.isError,true);assert.doesNotMatch(JSON.stringify(response),/PRIVATE_SENTINEL/);assert.match(JSON.stringify(response),new RegExp(id('a')));
});

test('inventory is advertised to the CTO connector and hidden from other lanes',async()=>{
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');const {callerSurfaceToolsFor}=await import('../registry.js');
 const make=()=>new McpServer({name:'inventory-surface-test',version:'1'},{capabilities:{tools:{listChanged:true}}});
 const cto=make(),coo=make();
 requestContext.run({callerHash:'cto',correlationId:'cto',callerAgent:'cto',connectorSurface:true},()=>registerChatActionInventory(cto,currentCallerHash));
 requestContext.run({callerHash:'coo',correlationId:'coo',callerAgent:'coo',connectorSurface:true},()=>registerChatActionInventory(coo,currentCallerHash));
 assert.ok(callerSurfaceToolsFor(cto).some((tool:any)=>tool.name==='chat_action_inventory'));
 assert.ok(!callerSurfaceToolsFor(coo).some((tool:any)=>tool.name==='chat_action_inventory'));
});
