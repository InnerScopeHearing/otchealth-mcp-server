import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const sourceEnvironment={STATE_BACKEND:'postgres',PG_HOST:'synthetic.invalid',PG_USER:'synthetic',PG_PASSWORD:'synthetic',
  XERO_CLIENT_ID:'synthetic-client',XERO_CLIENT_SECRET:'synthetic-client-secret',XERO_RT_OTCHEALTH:'synthetic-refresh'};
function runProbe(extra:Record<string,string>={}) {
  return spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
    "const {xeroConfigured,configuredOrgs}=await import('./src/tools/xero/client.ts');console.log(JSON.stringify({configured:xeroConfigured(),orgs:configuredOrgs()}));"],
    {cwd:process.cwd(),env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',...sourceEnvironment,...extra},encoding:'utf8',timeout:15000});
}
test('the actual Xero client initializes with only its source-owner credentials and PostgreSQL configuration',()=>{
  const r=runProbe();assert.equal(r.status,0,'minimal source-owner runtime must initialize without Customer.io credentials');
  assert.deepEqual(JSON.parse(r.stdout),{configured:true,orgs:['otchealth']});
});
test('missing Xero client credentials remain unconfigured',()=>{
  const r=runProbe({XERO_CLIENT_SECRET:''});assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).configured,false);
});
test('missing Xero bootstrap remains unconfigured and exposes no configured organization',()=>{
  const r=runProbe({XERO_RT_OTCHEALTH:''});assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),{configured:false,orgs:[]});
});
