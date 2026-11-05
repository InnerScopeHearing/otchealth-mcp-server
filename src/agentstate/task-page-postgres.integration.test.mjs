import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

// This test uses a connection-private TEMP table on the GitHub CI PostgreSQL service only.
// It cannot touch the user's local or company database and never uses live credentials.
test('paged task SQL runs against isolated CI PostgreSQL and preserves the privacy filters',
  {skip:process.env.GITHUB_ACTIONS !== 'true'}, async () => {
    const pg = (await import('pg')).default;
    const {queryTaskPage} = await import('./task-page-postgres.js');
    const {handleTaskList} = await import('../tools/agentstate/task-list.js');
    const pool = new pg.Pool({host:'127.0.0.1',port:5432,database:'agentstate_test',user:'postgres',
      password:'postgres',ssl:{rejectUnauthorized:false},max:1});
    let client;
    try {
      client = await pool.connect();
      await client.query('CREATE TEMP TABLE agentstate_tasks (pk text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, PRIMARY KEY (pk,id))');
      const records=Array.from({length:251},(_,i)=>{
        const id=`t_${String(i).padStart(4,'0')}`;
        const doc={id,board:'fixture',type:'task',owner_agent:i===4?'clo-personal':'cto',
          created_by:i===3?' CLO-PERSONAL ':i===5?'cfo':'cto', detail_readers:i===5?['cfo']:['cto'],
          title:i===5?'synthetic-restricted':'synthetic-own',description:'synthetic-detail',notes:['synthetic-note'],
          status:'open',priority:'normal',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',
          claim_ts:null,lease_until:null,lease_version:0,done_ts:null,attempt_count:0};
        return {id,doc};
      });
      await client.query("INSERT INTO agentstate_tasks (pk,id,doc) SELECT $1, x.doc->>'id', x.doc FROM jsonb_array_elements($2::jsonb) AS x(doc)",
        ['fixture',JSON.stringify(records.map(record=>record.doc))]);
      const wrapper={connect:async()=>({query:(...args)=>client.query(...args),release:()=>{}})};
      let after, all=[];
      for(;;){
        const page=await queryTaskPage(wrapper,{board:'fixture',status:'open',after,limit:100,includePersonal:false});
        all.push(...page.map(row=>row.id));
        if(page.length<100) break;
        after=page.at(-1).id;
      }
      assert.equal(all.length,249);
      assert.equal(new Set(all).size,249);
      assert.equal(all.includes('t_0003'),false);
      assert.equal(all.includes('t_0004'),false);
      assert.deepEqual(all,[...all].sort());

      const deps={isConfigured:()=>true,activeBackend:()=> 'postgres',listTasks:async()=>[],
        listTaskPage:input=>queryTaskPage(wrapper,input)};
      let cursor, visible=[];
      do {
        const result=await handleTaskList({board:'fixture',status:'open',view:'summary',paginate:true,limit:100,
          ...(cursor?{cursor}:{})},{callerAgent:'cto'},deps);
        assert.equal(result.data.snapshot,false);
        visible.push(...result.data.tasks);
        cursor=result.data.next_cursor??undefined;
      } while(cursor);
      assert.equal(visible.length,249);
      assert.equal(visible.some(row=>row.id==='t_0003'||row.id==='t_0004'),false);
      assert.equal(visible.find(row=>row.id==='t_0005').title,undefined);
      assert.doesNotMatch(JSON.stringify(visible),/synthetic-restricted|synthetic-detail|synthetic-note/);

      await client.query('INSERT INTO agentstate_tasks (pk,id,doc) VALUES ($1,$2,$3)',
        ['fixture','t_9999',JSON.stringify({id:'t_wrong',board:'fixture',type:'task',owner_agent:'cto',created_by:'cto',status:'open'})]);
      await assert.rejects(queryTaskPage(wrapper,{board:'fixture',after:'t_9998',limit:2,includePersonal:false}),/task_page_unavailable/);
    } finally {
      if(client) client.release();
      await pool.end();
    }
  });
