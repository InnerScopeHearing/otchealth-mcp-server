import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPageQuery, queryTaskPage } from './task-page-postgres.js';

const input = {board:'fleet', owner:'cto', status:'open', after:'t_0000', limit:3, includePersonal:false};
const doc = (id, extra = {}) => ({id, board:'fleet', type:'task', owner_agent:'cto', created_by:'cto', status:'open', priority:'normal', created_at:'2026-01-01T00:00:00Z', updated_at:'2026-01-01T00:00:00Z', ...extra});
function fakePool(rows, failAt = '') {
  const calls = [], state = { released: null };
  const client = { async query(text, values) {
    calls.push({text,values});
    if (text.includes(failAt) && failAt) throw Error('synthetic provider error containing a secret-like value');
    return text.startsWith('SELECT') ? {rows} : {rows:[]};
  }, release(discard) { state.released = discard; } };
  return {pool:{connect:async () => client}, calls, state};
}

test('keyset query binds inputs, applies both personal exclusions, and uses binary ID ordering', () => {
  const q = buildTaskPageQuery(input);
  assert.match(q.text, /lower\(btrim\(doc->>'owner_agent'\)\) <> 'clo-personal'/);
  assert.match(q.text, /lower\(btrim\(doc->>'created_by'\)\) <> 'clo-personal'/);
  assert.match(q.text, /doc->>'created_by' IS NULL/);
  assert.match(q.text, /id COLLATE "C" > \$\d+ COLLATE "C"/);
  assert.match(q.text, /ORDER BY id COLLATE "C" ASC LIMIT \$\d+$/);
  assert.deepEqual(q.values, ['fleet','cto','open','t_0000',3]);
  assert.ok(!q.text.includes('t_0000'));
  assert.throws(() => buildTaskPageQuery({...input, after:"x' OR 1=1 --"}), /invalid_input/);
  assert.throws(() => buildTaskPageQuery({...input, owner:"cto' OR 1=1 --"}), /invalid_input/);
});

test('successful reads use a bounded read-only transaction and release the client', async () => {
  const fake = fakePool([{id:'t_0001',doc:doc('t_0001',{created_at:'2026-01-01T00:00:00Z'})},{id:'t_0002',doc:doc('t_0002',{updated_at:'2026-01-01T00:00:00.1Z'})}]);
  const result = await queryTaskPage(fake.pool, input);
  assert.deepEqual(result.map(t => t.id), ['t_0001','t_0002']);
  assert.equal(fake.calls[0].text, 'BEGIN READ ONLY');
  assert.match(fake.calls[1].text, /statement_timeout/);
  assert.equal(fake.calls.at(-1).text, 'COMMIT');
  assert.equal(fake.state.released, false);
});

test('malformed, hidden, mismatched or out-of-order records fail closed and roll back', async () => {
  const bad = [
    [{id:'t_0001',doc:doc('t_0001',{created_by:null})}],
    [{id:'t_0001',doc:doc('t_0001',{created_by:' CLO-PERSONAL '})}],
    [{id:'t_0001',doc:doc('t_0002')}],
    [{id:'t_0002',doc:doc('t_0002')},{id:'t_0001',doc:doc('t_0001')}],
    [{id:'t_0001',doc:doc('t_0001',{board:'other'})}],
  ];
  for (const rows of bad) {
    const fake = fakePool(rows);
    await assert.rejects(queryTaskPage(fake.pool,input), /^Error: task_page_unavailable$/);
    assert.equal(fake.calls.at(-1).text, 'ROLLBACK');
    assert.equal(fake.state.released, false);
  }
});

test('provider errors are sanitized and rollback failures discard the connection', async () => {
  const fake = fakePool([], 'SELECT');
  await assert.rejects(queryTaskPage(fake.pool,input), /^Error: task_page_unavailable$/);
  assert.equal(fake.calls.at(-1).text, 'ROLLBACK');
  const client = {query:async text => {if (text.startsWith('SELECT') || text === 'ROLLBACK') throw Error('synthetic');return {rows:[]};}, release: v => {client.discarded=v;}};
  await assert.rejects(queryTaskPage({connect:async () => client},input), /^Error: task_page_unavailable$/);
  assert.equal(client.discarded, true);
});

test('missing or invalid task metadata never forms a successful page', async () => {
  const unfiltered = {...input, status:undefined};
  for (const extra of [{status:undefined},{status:'invented'},{priority:undefined},{priority:'invented'},
    {created_at:undefined},{created_at:'1'},{created_at:'2026-02-30T00:00:00Z'},
    {updated_at:'invalid-date'},{claim_ts:'2026-02-30T00:00:00Z'},
    {created_at:'2026-01-01T00:00:00+00:00'},
    {lease_version:-1},{attempt_count:'unknown'}]) {
    const fake = fakePool([{id:'t_0001',doc:doc('t_0001',extra)}]);
    await assert.rejects(queryTaskPage(fake.pool,unfiltered), /^Error: task_page_unavailable$/);
    assert.equal(fake.calls.at(-1).text, 'ROLLBACK');
  }
});

test('connection acquisition and release errors do not expose provider details', async () => {
  await assert.rejects(queryTaskPage({connect:async () => { throw Error('synthetic private endpoint'); }},input), /^Error: task_page_unavailable$/);
  const client = { query:async text => text.startsWith('SELECT') ? {rows:[]} : {rows:[]},
    release:() => {throw Error('synthetic private endpoint');} };
  await assert.rejects(queryTaskPage({connect:async () => client},input), /^Error: task_page_unavailable$/);
});

