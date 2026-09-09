import assert from 'node:assert/strict';
import test from 'node:test';

for (const [key,value] of Object.entries({CIO_SITE_ID:'synthetic',CIO_TRACK_KEY:'synthetic',CIO_APP_API_BEARER:'synthetic',PERPLEXITY_CONNECTOR_TOKEN:'synthetic-placeholder-value-000000000',ADMIN_REVOKE_TOKEN:'synthetic-placeholder-value-000000000',N8N_WEBHOOK_SECRET:'synthetic-placeholder-value-000000000'})) process.env[key]??=value;

const {relationshipPublicationTest}=await import('./relationship-publication.js');
const now=Date.parse('2026-09-09T12:00:00.000Z');
const base={catalog_key:'graph-trial/materialized-cfo/catalog.jsonl',catalog_source_sha256:'a'.repeat(64)};
function policy(source_policy:any,authenticated_caller='cfo'){
 return JSON.stringify({schema:'relationship-publication-policy-v1',policy_version:'cfo-all-source-v1',expires_at:new Date(now+60000).toISOString(),bindings:[{authenticated_caller,caller_hash:'b'.repeat(64),producer_id:'cfo-relationship-worker',cohort_id:'cfo-materialized',purpose:'company_graph_backfill',run_version:'cfo-v1',encryption:{algorithm:'AES256'},source_policy}]});
}

test('publication policy accepts explicit all-CFO scope and keeps legacy prefix mode',()=>{
 assert.ok(relationshipPublicationTest.parse(policy({...base,source_prefixes:[],source_scope:'all_cfo_source_documents'}),now));
 assert.ok(relationshipPublicationTest.parse(policy({...base,source_prefixes:['finance/']}),now));
});

test('publication policy rejects scope-prefix mismatches and non-CFO authority',()=>{
 assert.equal(relationshipPublicationTest.parse(policy({...base,source_prefixes:[]}),now),null);
 assert.equal(relationshipPublicationTest.parse(policy({...base,source_prefixes:['finance/'],source_scope:'all_cfo_source_documents'}),now),null);
 assert.equal(relationshipPublicationTest.parse(policy({...base,source_prefixes:[],source_scope:'all_company_documents'}),now),null);
 assert.equal(relationshipPublicationTest.parse(policy({...base,source_prefixes:[],source_scope:'all_cfo_source_documents'},'clo'),now),null);
});
