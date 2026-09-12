#!/usr/bin/env node
/** Bounded ECS entrypoint for the source-owned Xero handoff. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffProofFromResult } from "./xero-organisation-source-handoff-run.mjs";
const MAX=64*1024, PRIVATE_KEY=/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const parse=value=>{if(typeof value!=="string"||Buffer.byteLength(value,"utf8")<2||Buffer.byteLength(value,"utf8")>MAX||PRIVATE_KEY.test(value))fail("identity_registry_source_handoff_task_input_invalid");try{return JSON.parse(value);}catch{fail("identity_registry_source_handoff_task_input_invalid");}};
export function run({env=process.env,runner=join(import.meta.dirname,"xero-organisation-source-handoff-run.mjs"),spawn=spawnSync}={}){const deployment=parse(env.CFO_IDENTITY_REGISTRY_SOURCE_HANDOFF_DEPLOYMENT_JSON),dir=mkdtempSync(join(tmpdir(),"identity-registry-source-handoff-"));try{const input=join(dir,"deployment.json"),output=join(dir,"result.json");writeFileSync(input,JSON.stringify(deployment),{encoding:"utf8",mode:0o600,flag:"wx"});const child=spawn(process.execPath,[runner,"--deployment",input,"--output",output],{encoding:"utf8",stdio:"pipe",timeout:600000});if(child.error||child.status!==0)fail("identity_registry_source_handoff_task_failed");const raw=readFileSync(output,"utf8");if(Buffer.byteLength(raw,"utf8")<2||Buffer.byteLength(raw,"utf8")>MAX)fail("identity_registry_source_handoff_task_result_invalid");const handoff=handoffProofFromResult(JSON.parse(raw));return Object.freeze({schema:"cfo-identity-registry-source-handoff-task-v1",status:"published",handoff});}catch(error){if(error?.code)throw error;fail("identity_registry_source_handoff_task_failed");}finally{rmSync(dir,{recursive:true,force:true});}}
if(process.argv[1]&&process.argv[1].endsWith("identity-registry-source-handoff-task.mjs"))try{process.stdout.write(`${JSON.stringify(run())}\n`);}catch(error){process.stderr.write(`${JSON.stringify({schema:"cfo-identity-registry-source-handoff-task-v1",status:"error",code:typeof error?.code==="string"?error.code:"identity_registry_source_handoff_task_failed"})}\n`);process.exitCode=1;}
