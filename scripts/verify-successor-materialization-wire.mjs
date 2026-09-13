/** Actual CTO Python inspection/publication -> gateway receipt acceptance.
 * node --import tsx scripts/verify-successor-materialization-wire.mjs MATERIALIZER_DIRECTORY [PYTHON]
 * Synthetic in-memory source only; no AWS calls or model execution.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyMaterializationReceipt } from '../src/server/materialized-catalog-pin.ts';

assert.ok(process.argv[2], 'MATERIALIZER_DIRECTORY is required');
const canonicalSource="const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';";
for(const path of ['../src/server/graph-catalog-controller.ts','../src/server/relationship-historical-read.ts']){
  assert.ok(readFileSync(new URL(path,import.meta.url),'utf8').includes(canonicalSource),`gateway canonical producer changed: ${path}`);
}
// The two gateway producers are transitively import-bound to runtime env validation.
// Assert their exact serializer source, then execute that source-equivalent function
// to emit the bytes consumed by the Python source-owner capture below.
const gatewayCanonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(gatewayCanonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${gatewayCanonical(value[key])}`).join(',')}}`;
const python=process.argv[3] ?? 'python', producerCanonical=gatewayCanonical,
  grantCanonical=gatewayCanonical,sha=value=>createHash('sha256').update(value).digest('hex');
const runId='run_'+sha('gateway-producer-run'), proposalKey=sha('gateway-producer-proposal'),
  manifestSha=sha('gateway-producer-manifest'), callerHash=sha('gateway-producer-caller'), policyHash=sha('gateway-producer-policy'),
  documentVersion='docv_'+sha('gateway-producer-document');
const proposal={key:proposalKey,run:{ref_version:'neptune-trial-active-run-ref-v1',run_id:runId,purpose:'company_graph_backfill',scope:'finance',run_version:'synthetic-v1',manifest_sha256:manifestSha},manifest:{manifest_sha256:manifestSha,documents:[{document_version_id:documentVersion,source_version:sha('gateway-producer-source'),source_path_hash:sha('gateway-producer-path')}]}},
  unsignedAdmission={allowed:true,key:proposalKey,run_id:runId,manifest_sha256:manifestSha,max_documents:1,policy_sha256:policyHash},
  admission={...unsignedAdmission,decision_sha256:sha(producerCanonical(unsignedAdmission))};
const proposalKeyPath=`graph-trial/20260908/catalog-cohorts/cfo-catalog-publish-20260909-live/server/proposals/${proposalKey}.json`,
  admissionKeyPath=`graph-trial/20260908/catalog-cohorts/cfo-catalog-publish-20260909-live/server/admissions/${runId}.json`,
  proposalRaw=Buffer.from(producerCanonical(proposal)), admissionRaw=Buffer.from(producerCanonical(admission)),
  grantKeyPath=`graph-trial/20260908/relationship-publications/cfo/cfo-catalog-publish-20260909-live/cfo-relationship-worker/runs/${runId}.json`,
  grant={schema:'relationship-publication-grant-v1',cohort_id:'cfo-catalog-publish-20260909-live',producer_id:'cfo-relationship-worker',caller_hash:callerHash,run:proposal.run,
    admission:{key:admissionKeyPath,version_id:'admission-v1',sha256:sha(admissionRaw)},proposal:{key:proposalKeyPath,version_id:'proposal-v1',sha256:sha(proposalRaw)},artifact_ref:{},approved_artifacts:[],issued_under_policy_version:'policy-v1'},
  grantRaw=Buffer.from(grantCanonical(grant));
const producerFixture={config:{schema:'cfo-completed-publication-capture-config-v1',source_cohort_id:'cfo-catalog-publish-20260909-live',producer_id:'cfo-relationship-worker',expected_caller_hash:callerHash,expected_admission_policy_sha256:policyHash},objects:[
  {key:grantKeyPath,version_id:'grant-v1',raw_base64:grantRaw.toString('base64')},
  {key:proposalKeyPath,version_id:'proposal-v1',raw_base64:proposalRaw.toString('base64')},
  {key:admissionKeyPath,version_id:'admission-v1',raw_base64:admissionRaw.toString('base64')},
]};
const producerRaw=execFileSync(python,[fileURLToPath(new URL('./verify-successor-materialization-wire.py',import.meta.url)),process.argv[2],'--verify-gateway-producer-fixture'],{input:JSON.stringify(producerFixture),encoding:'utf8',maxBuffer:256*1024});
assert.deepEqual(JSON.parse(producerRaw),{status:'passed',captured_items:1});
const raw = execFileSync(python, [fileURLToPath(new URL('./verify-successor-materialization-wire.py', import.meta.url)), process.argv[2]], {encoding:'utf8', maxBuffer:256*1024});
const fixture = JSON.parse(raw), body = Buffer.from(fixture.receipt_base64, 'base64');
assert.equal(fixture.counts.eligible_rows, 1);
assert.equal(fixture.counts.excluded.unknown_extraction_quarantine, 2);
assert.equal(fixture.counts.excluded.already_published_source, 1);
assert.ok(fixture.completed_publication_exclusion_manifest);
assert.equal(fixture.completed_publication_exclusion_manifest.count, 1);
assert.ok(body.length <= 64*1024);
const verified = await verifyMaterializationReceipt(fixture.context, async request => {
  assert.equal(request.key, fixture.context.materialization.materialization_receipt_key);
  return {status:200, headers:new Headers({'x-amz-version-id':fixture.receipt_version}), body};
}, AbortSignal.timeout(5000));
assert.equal(verified.catalogVersionId, fixture.context.materialization.catalog_version_id);
console.log(JSON.stringify({schema:'successor-materialization-wire-check-v1', status:'passed', synthetic:true, aws_calls:0, eligible_rows:1, excluded_unknown_rows:2, excluded_completed_rows:1, receipt_bytes:body.length, gateway_producer_serialization:'passed'}));
