#!/usr/bin/env node
/** Bounded ECS entrypoint for the source-owned Xero handoff. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffProofFromResult } from "./xero-organisation-source-handoff-run.mjs";
const MAX=64*1024, PRIVATE_KEY=/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
// Only fixed source-code error labels may leave the private child process. Never
// relay its raw stderr, message, response body, or arbitrary error.code value.
const CHILD_CODES = new Set([
  'identity_export_kms_configuration', 'identity_export_kms_credentials_unavailable',
  'identity_export_kms_unavailable', 'identity_export_signature_invalid',
  'identity_export_store_configuration', 'identity_export_store_conflict', 'identity_export_store_invalid',
  'xero_organisation_cardinality_invalid', 'xero_organisation_connector_response_invalid',
  'xero_organisation_connector_unavailable', 'xero_organisation_created_at_invalid',
  'xero_organisation_deployment_invalid', 'xero_organisation_envelope_invalid',
  'xero_organisation_handoff_arguments_invalid', 'xero_organisation_handoff_deployment_invalid',
  'xero_organisation_handoff_deployment_unavailable', 'xero_organisation_handoff_invalid',
  'xero_organisation_handoff_result_invalid', 'xero_organisation_handoff_source_invalid',
  'xero_organisation_handoff_write_invalid', 'xero_organisation_identity_invalid',
  'xero_organisation_not_active', 'xero_organisation_not_company',
  'xero_organisation_projection_invalid', 'xero_organisation_record_invalid',
  'xero_organisation_source_handoff_unavailable',
]);
const TASK_CODES = new Set(['identity_registry_source_handoff_task_input_invalid',
  'identity_registry_source_handoff_task_result_invalid', 'identity_registry_source_handoff_task_failed',
  'identity_registry_source_handoff_task_timeout', 'identity_registry_source_handoff_module_missing']);
export function childFailureCode(child) {
  if (child?.error?.code === 'ETIMEDOUT') return 'identity_registry_source_handoff_task_timeout';
  const stderr = typeof child?.stderr === 'string' ? child.stderr.trim() : '';
  if (stderr.length <= MAX && CHILD_CODES.has(stderr)) return stderr;
  if (stderr.length <= MAX && /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.test(stderr)) return 'identity_registry_source_handoff_module_missing';
  return 'identity_registry_source_handoff_task_failed';
}
export function safeTaskErrorCode(error) {
  return CHILD_CODES.has(error?.code) || TASK_CODES.has(error?.code) ? error.code : 'identity_registry_source_handoff_task_failed';
}
const parse=value=>{if(typeof value!=="string"||Buffer.byteLength(value,"utf8")<2||Buffer.byteLength(value,"utf8")>MAX||PRIVATE_KEY.test(value))fail("identity_registry_source_handoff_task_input_invalid");try{return JSON.parse(value);}catch{fail("identity_registry_source_handoff_task_input_invalid");}};
export function run({env=process.env,runner=join(import.meta.dirname,"xero-organisation-source-handoff-run.mjs"),spawn=spawnSync}={}){const deployment=parse(env.CFO_IDENTITY_REGISTRY_SOURCE_HANDOFF_DEPLOYMENT_JSON),dir=mkdtempSync(join(tmpdir(),"identity-registry-source-handoff-"));try{const input=join(dir,"deployment.json"),output=join(dir,"result.json");writeFileSync(input,JSON.stringify(deployment),{encoding:"utf8",mode:0o600,flag:"wx"});const child=spawn(process.execPath,[runner,"--deployment",input,"--output",output],{encoding:"utf8",stdio:"pipe",timeout:600000});if(child.error||child.status!==0)fail(childFailureCode(child));const raw=readFileSync(output,"utf8");if(Buffer.byteLength(raw,"utf8")<2||Buffer.byteLength(raw,"utf8")>MAX)fail("identity_registry_source_handoff_task_result_invalid");const handoff=handoffProofFromResult(JSON.parse(raw));return Object.freeze({schema:"cfo-identity-registry-source-handoff-task-v1",status:"published",handoff});}catch(error){fail(safeTaskErrorCode(error));}finally{rmSync(dir,{recursive:true,force:true});}}
if(process.argv[1]&&process.argv[1].endsWith("identity-registry-source-handoff-task.mjs"))try{process.stdout.write(`${JSON.stringify(run())}\n`);}catch(error){process.stderr.write(`${JSON.stringify({schema:"cfo-identity-registry-source-handoff-task-v1",status:"error",code:safeTaskErrorCode(error)})}\n`);process.exitCode=1;}
