import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
const { handleTaskList } = await import('./task-list.js');

const mk=(i,extra={})=>({id:`t_${String(i).padStart(4,'0')}`,board:'fleet',type:'task',owner_agent:'cto',
  created_by:'cto',detail_readers:['cto'],title:'synthetic',description:'synthetic-description',notes:['synthetic-note'],
  status:'open',priority:'normal',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',
  claim_ts:null,lease_until:null,lease_version:0,done_ts:null,attempt_count:0,...extra});
function fixture(data) {
  const seen=[];
  const deps={isConfigured:()=>true,activeBackend:()=> 'postgres',listTasks:async filter=>{seen.push({legacy:filter});return data;},
    listTaskPage:async input=>{seen.push(input);return data.filter(t=>t.board===input.board && (!input.after||t.id>input.after)
      && (!input.owner||t.owner_agent===input.owner) && (!input.status||t.status===input.status)).slice(0,input.limit);}};
  return {deps,seen};
}

test('legacy default and summary retain their response and filters',async()=>{
  const f=fixture([mk(1)]);
  const full=await handleTaskList({limit:1},{callerAgent:'cto'},f.deps);
  assert.deepEqual(full.data.tasks[0].notes,['synthetic-note']);
  assert.deepEqual(f.seen[0].legacy,{limit:1,exclude_personal_legal:true});
  const summary=await handleTaskList({view:'summary',limit:1},{callerAgent:'cto'},f.deps);
  assert.equal(summary.data.tasks[0].notes,undefined);
  assert.equal(summary.data.next_cursor,undefined);
});

test('paged requests fail closed when storage is unavailable while legacy output stays unchanged',async()=>{
  const f=fixture([]);
  const deps={...f.deps,isConfigured:()=>false};
  const legacy=await handleTaskList({}, {callerAgent:'cto'}, deps);
  assert.deepEqual(legacy.data,{count:0,tasks:[],note:'agent-state Cosmos not configured.'});
  await assert.rejects(handleTaskList({paginate:true,view:'summary'}, {callerAgent:'cto'}, deps),/task_page_unavailable/);
  await assert.rejects(handleTaskList({paginate:true,view:'summary',cursor:'invalid'}, {callerAgent:'cto'}, deps),/task_page_unavailable/);
  assert.deepEqual(f.seen,[]);
});

test('paged summary enumerates 251 synthetic tasks with real privacy checks',async()=>{
  const data=Array.from({length:251},(_,i)=>mk(i));
  data[2]=mk(2,{created_by:'clo-personal',detail_readers:['clo-personal'],title:'hidden-synthetic'});
  data[3]=mk(3,{created_by:'cfo',detail_readers:['cfo'],title:'restricted-synthetic'});
  const f=fixture(data);let cursor, rows=[];
  do {
    const out=await handleTaskList({view:'summary',paginate:true,limit:100,...(cursor?{cursor}:{})},{callerAgent:'cto'},f.deps);
    assert.equal(out.data.snapshot,false);assert.equal(out.data.cursor_integrity,'unsigned');assert.equal(out.compactText,true);
    rows.push(...out.data.tasks);cursor=out.data.next_cursor??undefined;
  } while(cursor);
  assert.equal(rows.length,250);
  assert.equal(rows.some(t=>t.id==='t_0002'),false);
  assert.equal(rows.find(t=>t.id==='t_0003').title,undefined);
  assert.equal(rows.some(t=>t.notes!==undefined),false);
  assert.doesNotMatch(JSON.stringify(rows),/hidden-synthetic|restricted-synthetic/);
  assert.ok(f.seen.every(q=>q.includePersonal===false));
});

test('edited cursors may seek, and response discloses they do not prove coverage',async()=>{
  const f=fixture([mk(1),mk(2),mk(3)]);
  const first=await handleTaskList({paginate:true,view:'summary',limit:1},{callerAgent:'cto'},f.deps);
  const raw=JSON.parse(Buffer.from(first.data.next_cursor,'base64url').toString());
  raw.after='t_9999';
  const cursor=Buffer.from(JSON.stringify(raw)).toString('base64url');
  const skipped=await handleTaskList({paginate:true,view:'summary',limit:1,cursor},{callerAgent:'cto'},f.deps);
  assert.equal(skipped.data.next_cursor,null);
  assert.equal(skipped.data.cursor_integrity,'unsigned');
  assert.equal(skipped.data.snapshot,false);
});

test('paged inputs fail closed on wrong view, limit, missing caller, backend, and cursor scope',async()=>{
  const f=fixture([mk(1),mk(2)]);
  await assert.rejects(handleTaskList({paginate:true},{callerAgent:'cto'},f.deps),/invalid_pagination_input/);
  await assert.rejects(handleTaskList({paginate:true,view:'summary',limit:101},{callerAgent:'cto'},f.deps),/invalid_pagination_input/);
  await assert.rejects(handleTaskList({paginate:true,view:'summary'},{callerAgent:''},f.deps),/invalid_pagination_input/);
  await assert.rejects(handleTaskList({cursor:'abc'},{callerAgent:'cto'},f.deps),/invalid_cursor/);
  await assert.rejects(handleTaskList({paginate:true,view:'summary'},{callerAgent:'cto'},{...f.deps,activeBackend:()=> 'cosmos'}),/task_page_backend_unsupported/);
  const first=await handleTaskList({paginate:true,view:'summary',limit:1},{callerAgent:'cto'},f.deps);
  await assert.rejects(handleTaskList({paginate:true,view:'summary',limit:1,cursor:first.data.next_cursor},{callerAgent:'cfo'},f.deps),/invalid_cursor/);
});

test('bounded hidden scans disclose neither a hidden cursor nor a false complete page',async()=>{
  const data=[mk(0),...Array.from({length:20},(_,i)=>mk(i+1,{created_by:'clo-personal'}))];
  const f=fixture(data);
  const out=await handleTaskList({paginate:true,view:'summary',limit:1},{callerAgent:'cto'},f.deps);
  assert.equal(out.data.scan_incomplete,true);
  assert.deepEqual(out.data.tasks.map(t=>t.id),['t_0000']);
  assert.equal(JSON.parse(Buffer.from(out.data.next_cursor,'base64url').toString()).after,'t_0000');
  await assert.rejects(handleTaskList({paginate:true,view:'summary',limit:1,cursor:out.data.next_cursor},{callerAgent:'cto'},f.deps),/task_page_unavailable/);
});

