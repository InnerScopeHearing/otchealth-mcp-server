import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
const { handleTaskList } = await import('./task-list.js');
const { queryTaskPage } = await import('../../agentstate/task-page-postgres.js');

const mk=(i,extra={})=>({id:`t_${String(i).padStart(4,'0')}`,board:'fleet',type:'task',owner_agent:'cto',
  created_by:'cto',detail_readers:['cto'],title:'synthetic',notes:['synthetic-private'],status:'open',priority:'normal',
  created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',claim_ts:null,lease_until:null,
  lease_version:0,done_ts:null,attempt_count:0,...extra});

test('handler to fake PostgreSQL client carries scoped filters and does not return hidden details',async()=>{
  const all=Array.from({length:225},(_,i)=>mk(i));
  all[2]=mk(2,{created_by:'clo-personal',title:'synthetic-hidden'});
  all[3]=mk(3,{created_by:'cfo',detail_readers:['cfo'],title:'synthetic-restricted'});
  const seen=[];
  const pool={connect:async()=>({query:async(text,values)=>{
    if(!text.startsWith('SELECT')) return {rows:[]};
    assert.match(text,/COLLATE "C"/);assert.match(text,/created_by/);
    seen.push(values);
    let idx=1; const owner=values[idx++],status=values[idx++];
    const after=values.length===5?values[idx++]:'';const limit=values[idx];
    return {rows:all.filter(t=>t.board==='fleet' && t.owner_agent===owner && t.status===status &&
      t.created_by!=='clo-personal' && (!after||t.id>after)).slice(0,limit).map(doc=>({id:doc.id,doc}))};
  },release:()=>{}})};
  const deps={isConfigured:()=>true,activeBackend:()=> 'postgres',listTasks:async()=>[],listTaskPage:input=>queryTaskPage(pool,input)};
  let cursor, results=[];
  do {const out=await handleTaskList({view:'summary',paginate:true,limit:100,owner_agent:'cto',status:'open',...(cursor?{cursor}:{})},{callerAgent:'cto'},deps);
    results.push(...out.data.tasks);cursor=out.data.next_cursor??undefined;} while(cursor);
  assert.equal(results.length,224);assert.equal(results.some(t=>t.id==='t_0002'),false);
  assert.equal(results.find(t=>t.id==='t_0003').title,undefined);
  assert.doesNotMatch(JSON.stringify(results),/synthetic-hidden|synthetic-restricted|synthetic-private/);
  assert.ok(seen.length>=3);
});

