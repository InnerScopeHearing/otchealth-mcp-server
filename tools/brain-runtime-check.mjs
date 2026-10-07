// Source-free checks of compiled Brain modules. This runner accepts no source inputs,
// never loads credentials and replaces all provider I/O before invoking retrieval.
import assert from 'node:assert/strict';
Object.assign(process.env, {
  NODE_ENV: 'test', STATE_BACKEND: 'cosmos', BLOB_BACKEND: 'azure',
  SEARCH_BACKEND: 'azure', LLM_PROVIDER: 'openai', EMBEDDINGS_PROVIDER: 'openai',
  WEB_SEARCH_PROVIDER: 'azure', OPENAI_USAGE_DISABLE: '1',
  CIO_SITE_ID: 'synthetic', CIO_TRACK_KEY: 'synthetic', CIO_APP_API_BEARER: 'synthetic',
  PERPLEXITY_CONNECTOR_TOKEN: 'x'.repeat(32), ADMIN_REVOKE_TOKEN: 'x'.repeat(32),
  N8N_WEBHOOK_SECRET: 'x'.repeat(32), OPENAI_API_KEY: 'synthetic-runtime-fixture',
  AZURE_SEARCH_ENDPOINT: 'https://synthetic-search.example.invalid',
  AZURE_SEARCH_QUERY_KEY: 'synthetic-runtime-fixture',
});
assert.match(process.env.GIT_SHA ?? '', /^[a-f0-9]{40}$/i, 'image must carry its exact source commit');
const { dedupeById, buildCitations, deepStageTimingFields, deepRetrieve, PARTIAL_BUDGET_ANSWER } = await import('../dist/memory/deep-retrieval.js');
const hits = [
  { score: 1, source: 'synthetic-room-a', id: 'same', agent: 'coo', text: 'synthetic-A', source_version: 'v1' },
  { score: 0.9, source: 'synthetic-room-a', id: 'same', agent: 'coo', text: 'synthetic-B', source_version: 'v2' },
  { score: 0.8, source: 'synthetic-room-b', id: 'same', agent: 'coo', text: 'synthetic-C', source_version: 'v1' },
];
assert.deepEqual(dedupeById([...hits, hits[0]]), hits);
assert.deepEqual(buildCitations(hits).map(c => [c.source, c.source_version]), hits.map(h => [h.source, h.source_version]));
const timing = deepStageTimingFields('planning', 10, 20, 'partial', 'synthetic-correlation', process.env.GIT_SHA);
assert.deepEqual(Object.keys(timing).sort(), ['correlation_id','duration_ms','outcome','release_id','stage','type']);
assert.equal(timing.duration_ms, 10); assert.equal(timing.release_id, process.env.GIT_SHA);
// Allow emulated ARM startup to reach the mock before expiry; this is a cancellation
// fixture, not a microsecond performance threshold. Production defaults are unchanged.
const originalFetch = globalThis.fetch;
let aborted = false, retrievalCalls = 0;
try {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"sub_queries":["synthetic"]}' } }] }))), 10_000);
      const abort = () => { clearTimeout(timer); aborted = true; reject(init.signal.reason); };
      if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
    });
    retrievalCalls++; throw new Error('Unexpected synthetic provider request');
  };
  const result = await deepRetrieve('synthetic-runtime-query', { rooms: ['memory-exec'], budgetMs: 2_000 });
  assert.equal(aborted, true); assert.equal(retrievalCalls, 0);
  assert.equal(result.partial, true); assert.equal(result.answer, PARTIAL_BUDGET_ANSWER);
  assert.deepEqual(result.hits, []); assert.deepEqual(result.citations, []);
  assert.deepEqual(result.continuation.rooms, ['memory-exec']);
} finally { globalThis.fetch = originalFetch; }

const { filterSupersededWakeData, buildBriefWake, buildM365LiteWake, readWakeTasks } = await import('../dist/tools/memory/wake.js');
const { filterSupersededPackData, buildBriefPack } = await import('../dist/tools/memory/pack.js');
const { getRetractionSnapshot, noteRetraction, __setRetractionReadersForTests, __resetRetractionCache } = await import('../dist/memory/retractions.js');
const { deliverCheckpointBatch } = await import('../dist/tools/memory/checkpoint-delivery.js');
const { handleBrainSearch } = await import('../dist/tools/kb/brain-search.js');
const old = { id: 'synthetic-old', agent: 'cto', type: 'fact', text: 'synthetic retired value' };
const foreign = { ...old, agent: 'cro', to: 'cto' };
const full = {
  agent: 'cto', pack: { configured: true, status: old, corrections: [], decisions: [], recent: [old], count: 1 },
  memory_records: [old], tasks: { configured: true, active: [], counts: {} },
  inbox: { configured: true, count: 0, preview: [] },
  inbound: { configured: true, count: 1, sinceMarker: '', notes: [foreign] },
  errors: [], doctrine: { definition_of_done: 'synthetic', pitfalls: [], standing_directives: [] },
};
const current = filterSupersededWakeData(full, [{ id: 'synthetic-new', agent: 'cto', type: 'status', supersedes: old.id }], new Set([old.id]));
for (const view of [current, buildBriefWake(current)]) {
  assert.equal(view.pack.status, null);
  assert.deepEqual(view.memory_records, []);
  assert.equal(view.inbound.notes[0].agent, 'cro');
}
const m365Current = buildM365LiteWake(current);
assert.equal(m365Current.pack.status, null);
assert.deepEqual(m365Current.memory_records, []);
assert.deepEqual(m365Current.inbound.notes, []);
const packed = filterSupersededPackData({ agent:'cto', status:old, corrections:[], decisions:[], recent:[old], count:1 }, [], new Set([old.id]));
assert.equal(packed.status, null); assert.deepEqual(packed.recent, []);
const prefixedLocal = [{agent:'cto',type:'status',supersedes:'cto__'+old.id}];
assert.equal(filterSupersededWakeData(full,prefixedLocal,new Set()).pack.status,null);
assert.equal(filterSupersededPackData({agent:'cto',status:old,corrections:[],decisions:[],recent:[old],count:1},prefixedLocal,new Set()).status,null);
assert.deepEqual(buildBriefWake(full,[...prefixedLocal,old],new Set()).pack.recent,[]);
assert.deepEqual(buildBriefPack({agent:'cto',status:old,corrections:[],decisions:[],recent:[old],count:1},[...prefixedLocal,old],new Set()).recent,[]);
const terminal = Array.from({length:75},(_,i)=>({id:'done-'+i,owner_agent:'cto',status:'done',created_at:'2026-10-06T00:00:00Z'}));
const active = {id:'old-open',owner_agent:'cto',status:'open',created_at:'2026-01-01T00:00:00Z'};
const taskResult = await readWakeTasks('cto','cto',5,async opts => [...terminal,active].filter(t=>t.owner_agent===opts.owner_agent&&t.status===opts.status).slice(0,opts.limit));
assert.equal(taskResult.active[0].id,'old-open');
assert.equal(taskResult.counts_scope,'bounded_active_status_samples');
__setRetractionReadersForTests({shared:async()=>{throw new Error('synthetic-unavailable')},memory:async()=>[{agent:'cto',supersedes:'synthetic-old'}]});
const snapshot=await getRetractionSnapshot(); assert.equal(snapshot.verified,false); assert.equal(snapshot.byAgent.get('cto').has('synthetic-old'),true);
process.env.DEEP_RETRIEVAL_MODE='on'; process.env.RETRIEVAL_SHIELD_MODE='off';
const entity={id:'synthetic-current',owner:'cto',ekey:'synthetic_current_value',evalue:'new',ts:'2026-10-06',source:'synthetic receipt',matchedBy:'current-question'};
const ctx={correlationId:'synthetic',callerHash:'synthetic',dryRun:false,acknowledgeWarning:false,callerAgent:'cto'};
const deepFixture={mode:'deep-agentic',answer:'synthetic older generated answer [1].',citations:[{n:1,id:'cto__synthetic-current',source:'memory-exec'}],hits:[{id:'cto__synthetic-current',agent:'cto',source:'memory-exec',text:'synthetic',score:1}],rooms_searched:['memory-exec'],sub_queries:['synthetic'],rounds_used:1};
const promoted=await handleBrainSearch({query:'synthetic',mode:'deep'},ctx,{lookupEntity:async()=>entity,deepRetrieve:async()=>deepFixture});
assert.match(promoted.data.answer,/Current value: synthetic_current_value = new \[1\]/);
assert.equal(promoted.data.matches.length,1); assert.equal(promoted.data.citations[0].id,entity.id);
assert.equal(promoted.data.retraction_verification,'incomplete'); assert.match(promoted.summary,/verification incomplete/);
const partial=await handleBrainSearch({query:'synthetic',mode:'deep'},ctx,{lookupEntity:async()=>entity,deepRetrieve:async()=>({...deepFixture,partial:true,continuation:{rooms:['memory-exec'],sub_queries:['synthetic'],rounds_used:1}})});
assert.equal(partial.data.answer,deepFixture.answer); assert.deepEqual(partial.data.citations,deepFixture.citations);
assert.equal(partial.data.matches[0].id,deepFixture.hits[0].id);
let retractedDuringDeep=false;
const lateRetraction=await handleBrainSearch({query:'synthetic',mode:'deep'},ctx,{
  deepRetrieve:async()=>{retractedDuringDeep=true;return deepFixture},
  retractedIdsByAgent:async()=>{assert.equal(retractedDuringDeep,true);return new Map([['cto',new Set([entity.id])]])},
  lookupEntity:async(_query,_mode,byAgent)=>{assert.equal(byAgent.get('cto').has(entity.id),true);return null},
});
assert.equal(lateRetraction.data.retraction_changed,true);assert.equal(lateRetraction.data.partial,true);
assert.deepEqual(lateRetraction.data.matches,[]);assert.deepEqual(lateRetraction.data.citations,[]);
assert.equal(String(lateRetraction.data.answer).includes(deepFixture.answer),false);
process.env.RETRIEVAL_SHIELD_MODE='enforce';
const unscreenedHits=[...Array.from({length:12},(_,i)=>({id:'synthetic-other-'+i,source:'memory-exec',agent:'cto',score:1,text:'synthetic'})),...deepFixture.hits];
const withheld=await handleBrainSearch({query:'synthetic',mode:'deep'},ctx,{lookupEntity:async()=>entity,deepRetrieve:async()=>({...deepFixture,hits:unscreenedHits,injection_screen:{mode:'enforce',attackDetected:false}})});
assert.equal('entity_answer' in withheld.data,false);assert.equal(withheld.data.answer,deepFixture.answer);
const mismatch=await handleBrainSearch({query:'synthetic',mode:'deep'},ctx,{lookupEntity:async()=>entity,deepRetrieve:async()=>({...deepFixture,injection_screen:{mode:'enforce',attackDetected:false}})});
assert.equal('entity_answer' in mismatch.data,false,'the promoted payload itself must have been screened');
process.env.RETRIEVAL_SHIELD_MODE='off';
__resetRetractionCache();
let releaseCold;
const coldSource=new Promise(resolve=>{releaseCold=resolve});
__setRetractionReadersForTests({shared:async()=>coldSource,memory:async()=>[]});
const coldPending=getRetractionSnapshot();noteRetraction('cto','cto__cold-proof');releaseCold([]);
assert.equal((await coldPending).byAgent.get('cto').has('cold-proof'),true);__resetRetractionCache();
let inflight=0,maxInflight=0;
const deliveries=await deliverCheckpointBatch([0,1,2,3,4,5],async index=>{
  inflight++;maxInflight=Math.max(maxInflight,inflight);await new Promise(resolve=>setTimeout(resolve,2));inflight--;
  if(index===2) throw new Error('synthetic lost acknowledgement');
  return {id:'synthetic-'+index,stored:true,indexed:index!==3};
});
assert.equal(maxInflight,4); assert.deepEqual(deliveries.map(d=>d.id),['synthetic-0','synthetic-1',null,'synthetic-3','synthetic-4','synthetic-5']);assert.equal(deliveries[3].indexed,false);
const serial=await deliverCheckpointBatch([0,1,2],async i=>{if(i===1)throw new Error('synthetic');return{id:String(i),stored:true,indexed:true}},4,true);
assert.deepEqual(serial.map(d=>d.id),['0',null,'2']);

console.log(JSON.stringify({ status: 'pass', checks: 8, source_sha: process.env.GIT_SHA, provider_calls: 0, source_bodies: 0 }));
