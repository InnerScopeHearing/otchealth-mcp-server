import assert from "node:assert/strict";import test from "node:test";import {readFileSync,writeFileSync} from "node:fs";import {run} from "./identity-registry-source-handoff-task.mjs";
const deployment={schema:"cfo-xero-organisation-source-handoff-deployment-v1",source_deployment:{schema:"cfo-xero-organisation-source-deployment-v1",deployment:{}},export_input:{registry_id:"cfo-identity-registry-pilot"}};test("materializes only metadata source deployment and logs only immutable handoff proof",()=>{let args;const result=run({env:{CFO_IDENTITY_REGISTRY_SOURCE_HANDOFF_DEPLOYMENT_JSON:JSON.stringify(deployment)},spawn:(_bin,next)=>{args=next;writeFileSync(next[4],JSON.stringify({schema:"cfo-xero-organisation-source-handoff-result-v1",handoff:{key:"graph-trial/20260912/identity-registry/cfo-pilot/source/identity-registries/xero-organisation/handoffs/x.json",version_id:"v1",sha256:"a".repeat(64)},source_receipt:{company_only_gate:true}}));return {status:0};}});assert.equal(result.handoff.sha256,"a".repeat(64));assert.equal(JSON.stringify(result).includes("company_only_gate"),false);assert.equal(args[0].endsWith("xero-organisation-source-handoff-run.mjs"),true);});
test("runtime image copies the wrapper required by the ECS entrypoint",()=>{const docker=readFileSync(new URL("../Dockerfile",import.meta.url),"utf8");assert.equal(docker.includes("/app/tools/identity-registry-source-handoff-task.mjs"),true);});

test('failed child preserves its fixed diagnostic label through the real wrapper', () => {
  assert.throws(() => run({ env: { CFO_IDENTITY_REGISTRY_SOURCE_HANDOFF_DEPLOYMENT_JSON: JSON.stringify(deployment) },
    spawn: () => ({ status: 1, stderr: 'xero_organisation_connector_unavailable\n' }) }),
  error => error.code === 'xero_organisation_connector_unavailable');
});

test('child diagnostics never forward arbitrary stderr or error properties', async () => {
  const { childFailureCode, safeTaskErrorCode } = await import('./identity-registry-source-handoff-task.mjs');
  for (const stderr of ['synthetic-sensitive-value', 'xero_organisation_connector_unavailable synthetic-sensitive-value',
    'xero_organisation_unknown_value', 'x'.repeat(65537)]) {
    assert.equal(childFailureCode({ status: 1, stderr }), 'identity_registry_source_handoff_task_failed');
  }
  assert.equal(safeTaskErrorCode({ code: 'synthetic-sensitive-value' }), 'identity_registry_source_handoff_task_failed');
  assert.equal(childFailureCode({ error: { code: 'ETIMEDOUT', message: 'synthetic-sensitive-value' } }), 'identity_registry_source_handoff_task_timeout');
  assert.equal(childFailureCode({ stderr: 'ERR_MODULE_NOT_FOUND synthetic-sensitive-value' }), 'identity_registry_source_handoff_module_missing');
});
