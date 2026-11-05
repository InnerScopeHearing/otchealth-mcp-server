import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);
process.env.STATE_BACKEND = 'postgres';
process.env.PG_HOST = 'synthetic.invalid';
process.env.JIT_RESULT_THRESHOLD_CHARS = '40000';
const { handleTaskList } = await import('./task-list.js');
const { buildTextContent } = await import('../registry.js');
const { shouldOffload, offloadResult, fetchStoredResult, COMPACT_RESULT_JSON_MODE_ENV } = await import('../result-store.js');

const row=i=>({id:`t_${String(i).padStart(4,'0')}`,board:'fleet',type:'task',owner_agent:'cto',created_by:'cto',
  detail_readers:['cto'],title:'synthetic-'.repeat(60),description:'private-synthetic',notes:['private-synthetic'],
  status:'open',priority:'normal',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',
  claim_ts:null,lease_until:null,lease_version:0,done_ts:null,attempt_count:0});

test('offloaded task page preserves cursor and caller binding in both storage formats',async()=>{
  const tasks=Array.from({length:150},(_,i)=>row(i));
  tasks[2]={...tasks[2],created_by:'clo-personal',detail_readers:['clo-personal'],title:'hidden-synthetic'};
  tasks[3]={...tasks[3],created_by:'cfo',detail_readers:['cfo'],title:'restricted-synthetic'};
  const deps={isConfigured:()=>true,activeBackend:()=> 'postgres',listTasks:async()=>[],
    listTaskPage:async q=>tasks.filter(t=>!q.after||t.id>q.after).slice(0,q.limit)};
  const first=await handleTaskList({view:'summary',paginate:true,limit:100},{callerAgent:'cto'},deps);
  const text=buildTextContent(first,null);assert.ok(shouldOffload(text));
  const caller='a'.repeat(64),other='b'.repeat(64),previous=process.env[COMPACT_RESULT_JSON_MODE_ENV];
  try {
    for(const mode of ['off','on']) {
      process.env[COMPACT_RESULT_JSON_MODE_ENV]=mode;
      const docs=new Map();const storage={newId:()=>`jitres_${mode}`,now:()=>1000,logProjection:()=>{},
        upsertDoc:async (_c,id,doc)=>{docs.set(id,structuredClone(doc));},
        readDoc:async (_c,id)=>docs.has(id)?{doc:structuredClone(docs.get(id))}:null};
      const off=await offloadResult(text,first.data,'corr-synthetic',caller,storage,'task_list');assert.ok(off);
      assert.equal((await fetchStoredResult(off.resultId,0,other,storage)).found,false);
      assert.equal((await fetchStoredResult(off.resultId,0,caller,storage,undefined,'other_tool')).found,false);
      let chunks=[];
      for(let p=0;;p++){const part=await fetchStoredResult(off.resultId,p,caller,storage,undefined,'task_list');
        assert.equal(part.found,true);chunks.push(part.chunk);if(p+1>=part.pages)break;}
      const parsed=JSON.parse(chunks.join(''));
      assert.equal(parsed.next_cursor,first.data.next_cursor);
      assert.equal(parsed.tasks.length,100);
      assert.doesNotMatch(JSON.stringify(parsed),/private-synthetic|hidden-synthetic|restricted-synthetic/);
      const second=await handleTaskList({view:'summary',paginate:true,limit:100,cursor:parsed.next_cursor},{callerAgent:'cto'},deps);
      assert.equal(second.data.tasks.length,49);
      assert.equal(second.data.next_cursor,null);
      assert.equal(new Set([...parsed.tasks,...second.data.tasks].map(t=>t.id)).size,149);
    }
  } finally {if(previous===undefined)delete process.env[COMPACT_RESULT_JSON_MODE_ENV];else process.env[COMPACT_RESULT_JSON_MODE_ENV]=previous;}
});

