import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.CIO_SITE_ID='test';process.env.CIO_TRACK_KEY='test';process.env.CIO_APP_API_BEARER='test';process.env.PERPLEXITY_CONNECTOR_TOKEN='p'.repeat(32);process.env.ADMIN_REVOKE_TOKEN='a'.repeat(32);process.env.N8N_WEBHOOK_SECRET='n'.repeat(32);
process.env.STATE_BACKEND='postgres';process.env.PG_HOST='synthetic.invalid';process.env.PG_SSL_VERIFY='false';
const pg=(await import('pg')).default;
const original=pg.Pool.prototype.connect;
const {resetPoolForTests}=await import('../../agentstate/postgres.js');
const {handleChatActionInventory}=await import('./chat-action-inventory.js');
test('real dispatcher uses a read-only transaction with server-side statement timeout and bytewise pagination',async()=>{
 const calls:any[]=[];let released=0;const id='caj_'+'a'.repeat(64);
 (pg.Pool.prototype as any).connect=async()=>({query:async(sql:string,values?:unknown[])=>{
  calls.push({sql,values});if(sql.startsWith('SELECT')) return {rows:[{doc:{id,status:'running',action:'brain_search',caller_agent:'coo',created_at:'2026-11-05T00:00:00.000Z',updated_at:'2026-11-05T00:00:00.000Z'}}],rowCount:1};return {rows:[]};
 },release:()=>{released++;}});
 try {
  const out=await handleChatActionInventory({owner:'coo',page_size:2},{callerAgent:'cto'});assert.equal(out.data.jobs[0].id,id);assert.equal(out.data.next_cursor,null);assert.equal(released,1);
  assert.equal(calls[0].sql,'BEGIN READ ONLY');assert.equal(calls[1].sql,"SET LOCAL statement_timeout = '2500ms'");
  assert.match(calls[2].sql,/jsonb_build_object/);assert.match(calls[2].sql,/agentstate_events/);assert.match(calls[2].sql,/COLLATE "C"/);assert.match(calls[2].sql,/LIMIT \$4/);
  assert.doesNotMatch(calls[2].sql,/request|result|caller_hash|SELECT \*/i);assert.deepEqual(calls[2].values,['chat_action_job','coo','',3]);assert.equal(calls[3].sql,'COMMIT');
 } finally {(pg.Pool.prototype as any).connect=original;await resetPoolForTests();}
});

test('server timeout aborts the query, rolls back and never returns partial rows',async()=>{
 const calls:string[]=[];let released=0;const timeout=Object.assign(new Error('synthetic statement timeout'),{code:'57014'});
 (pg.Pool.prototype as any).connect=async()=>({query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SELECT'))throw timeout;return {rows:[]};},release:()=>{released++;}});
 try {await assert.rejects(()=>handleChatActionInventory({owner:'coo'},{callerAgent:'cto'}),e=>e===timeout);assert.equal(calls[0],'BEGIN READ ONLY');assert.equal(calls[1],"SET LOCAL statement_timeout = '2500ms'");assert.equal(calls.at(-1),'ROLLBACK');assert.equal(released,1);}
 finally {(pg.Pool.prototype as any).connect=original;await resetPoolForTests();}
});

test('fallback backend is rejected before any database or network call',async()=>{
 process.env.STATE_BACKEND='cosmos';let connected=0;(pg.Pool.prototype as any).connect=async()=>{connected++;throw new Error('unexpected connection');};
 try {await assert.rejects(()=>handleChatActionInventory({owner:'coo'},{callerAgent:'cto'}),/inventory_backend_unsupported/);assert.equal(connected,0);}
 finally {process.env.STATE_BACKEND='postgres';(pg.Pool.prototype as any).connect=original;await resetPoolForTests();}
});

test('failure to set the timeout aborts before selection and rollback failure discards the client',async()=>{
 const calls:string[]=[];let discarded:unknown;const failure=new Error('synthetic set failure');
 (pg.Pool.prototype as any).connect=async()=>({query:async(sql:string)=>{calls.push(sql);if(sql.startsWith('SET LOCAL'))throw failure;if(sql==='ROLLBACK')throw new Error('rollback failed');return {rows:[]};},release:(bad:unknown)=>{discarded=bad;}});
 try {await assert.rejects(()=>handleChatActionInventory({owner:'coo'},{callerAgent:'cto'}),e=>e===failure);assert.deepEqual(calls,['BEGIN READ ONLY',"SET LOCAL statement_timeout = '2500ms'",'ROLLBACK']);assert.equal(discarded,true);}
 finally {(pg.Pool.prototype as any).connect=original;await resetPoolForTests();}
});
