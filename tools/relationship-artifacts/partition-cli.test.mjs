import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(v).digest('hex');
test('ordinary partition CLI validates every shard before controller startup and refuses an unavailable shard',
  {skip:!process.env.RELATIONSHIP_CTO_ROOT},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'synthetic-partition-cli-'));
  try{
    const ctoRoot=resolve(process.env.RELATIONSHIP_CTO_ROOT);
    const {createSignedPartitionManifest}=await import(pathToFileURL(join(ctoRoot,'tools/neptune-trial/source-identity-registry/partition-manifest.mjs')).href);
    const {publicKey,privateKey}=generateKeyPairSync('ed25519'),pem=publicKey.export({type:'spki',format:'pem'}),keyHash=sha(publicKey.export({type:'spki',format:'der'}));
    const authority={schema:'authenticated-structured-identity-authority-v1',scope:'cfo',adapter_id:'synthetic',source_system:'synthetic',version:'1'};
    const envelopes={},shards=[];
    for(const prefix of '0123456789abcdef'){
      const snapshot={schema:'source-identity-registry-v1',registry_id:'synthetic',version:`shard-${prefix}-v1`,source_authority:authority,source_version:'generation-1',
        public_key_sha256:keyHash,entries:[],revocations:[],partition_binding_hashes:[]};
      const id=`shard-${prefix}`;envelopes[id]={snapshot,signature:sign(null,Buffer.from(canonical(snapshot)),privateKey).toString('base64')};
      shards.push({shard_id:id,partition_prefix:prefix,registry_version:snapshot.version,snapshot_sha256:sha(canonical(snapshot)),source_version:'generation-1',binding_count:0,binding_set_sha256:sha('[]')});
    }
    const catalogCoverage={schema:'source-identity-catalog-coverage-v1',catalog_version:'synthetic-catalog',coverage_sha256:sha('synthetic-catalog'),complete:true,
      expected_shard_count:16,source_binding_count:0,source_binding_set_sha256:sha('[]')};
    const manifest=await createSignedPartitionManifest({registryId:'synthetic',sourceAuthority:authority,sourceGeneration:'generation-1',catalogCoverage,shards,
      signer:{publicKey:pem,sign:async({payload})=>sign(null,payload,privateKey).toString('base64')}});
    const binary=join(directory,'codex.exe'),host=join(directory,'host.json'),key=join(directory,'public.pem'),config=join(directory,'runtime.json');
    const project=join(directory,'CFO','.codex','config.toml'),preload=join(directory,'transport.mjs'),audit=join(directory,'audit.json');
    await mkdir(dirname(project),{recursive:true});await writeFile(project,'[mcp_servers.otchealth.http_headers]\nAuthorization = "Bearer synthetic-only-not-real"\n');
    await writeFile(binary,'synthetic never executed');await writeFile(key,pem);
    await writeFile(host,JSON.stringify({schema:'company-catalog-controller-host-v1',seat:'cfo',binary,cohort_id:'synthetic'}));
    await writeFile(config,JSON.stringify({schema:'relationship-backfill-runtime-v1',review_mode:'partitioned-signed-review',review_model:'gpt-5.6-luna',cto_root:ctoRoot,host_config:host,
      outbox_directory:join(directory,'outbox'),cfo_project_config:project,producer:'reviewer',registry:{id:'synthetic',version:manifest.snapshot.version,public_key_file:key,authority}}));
    const transport=missing=>`import {writeFileSync,readFileSync} from 'node:fs';
      const envelopes=${JSON.stringify(envelopes)},manifest=${JSON.stringify(manifest)};let shards=0,pages=0;
      globalThis.fetch=async(url,init)=>{const u=new URL(url),p=u.pathname;
        if(u.origin!=='https://mcp.otchealth.app')throw Error('unexpected origin');
        const current=readFileSync(${JSON.stringify(project)},'utf8').includes('synthetic-rotated-only-not-real')?'synthetic-rotated-only-not-real':'synthetic-only-not-real';
        if(new Headers(init.headers).get('authorization')!=='Bearer '+current)throw Error('stale fixture credential');
        if(p.includes('/shards/')){shards++;const id=p.split('/').at(-1);return new Response(JSON.stringify(envelopes[id]),{status:${missing}&&id==='shard-f'?404:200});}
        if(p.endsWith('/current'))return new Response(JSON.stringify({current:true}),{status:200});
        if(p.endsWith('/coverage')){pages++;return new Response(JSON.stringify({schema:'source-identity-catalog-coverage-page-v1',source_generation:'generation-1',catalog_version:'synthetic-catalog',coverage_sha256:${JSON.stringify(catalogCoverage.coverage_sha256)},binding_hashes:[],next_cursor:null}),{status:200});}
        if(p.includes('/partitions/')){writeFileSync(${JSON.stringify(project)},'[mcp_servers.otchealth.http_headers]\\nAuthorization = "Bearer synthetic-rotated-only-not-real"\\n');return new Response(JSON.stringify(manifest),{status:200});}
        if(p.endsWith('/config')){writeFileSync(${JSON.stringify(audit)},JSON.stringify({shards,pages}));return new Response(JSON.stringify({enabled:false,cohort_id:'synthetic',policy_sha256:'a'.repeat(64),max_admissions:0,controller:{catalogSourceSha256:'b'.repeat(64),purpose:'relationship-candidates',runVersion:'synthetic-v1',batchSize:1}}),{status:200});}
        throw Error('unexpected route');};`;
    const execute=mode=>spawnSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./full-backfill-cli.mjs',import.meta.url)),mode,'--config',config],
      {encoding:'utf8',windowsHide:true,timeout:30000});
    await writeFile(preload,transport(false));
    const check=execute('--check');assert.equal(check.status,0,check.stderr);assert.match(check.stdout,/partitioned-signed-review/);
    if(process.platform==='win32'){
      const authorityFile=join(directory,'authority.json'),installation=join(directory,'prepared');
      await writeFile(authorityFile,JSON.stringify(authority));
      const prepared=spawnSync(process.env.RELATIONSHIP_POWERSHELL||'pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',
        fileURLToPath(new URL('./Prepare-RelationshipBackfill.ps1',import.meta.url)),'-InstallDirectory',installation,
        '-NodePath',process.execPath,'-CtoRoot',ctoRoot,'-CfoProjectConfig',project,'-CodexPath',binary,'-CohortId','synthetic',
        '-Producer','reviewer','-ReviewModel','gpt-5.6-sol','-ReviewMode','partitioned-signed-review','-RegistryId','synthetic','-RegistryVersion',manifest.snapshot.version,
        '-RegistryPublicKeyFile',key,'-RegistryAuthorityFile',authorityFile],{encoding:'utf8',windowsHide:true,timeout:30000});
      assert.equal(prepared.status,0,prepared.stderr||prepared.error?.message);
      const saved=JSON.parse(await readFile(join(installation,'runtime.json'),'utf8'));
      assert.equal(saved.review_mode,'partitioned-signed-review');assert.equal(saved.review_model,'gpt-5.6-sol');assert.equal(saved.registry.version,manifest.snapshot.version);
      assert.match(prepared.stdout,/Scheduler not registered or activated/);
    }
    const result=execute('--once');assert.equal(result.status,2,result.stderr);assert.match(result.stdout,/disabled/);
    assert.deepEqual(JSON.parse(await readFile(audit,'utf8')),{shards:16,pages:1});
    await writeFile(preload,transport(true));const missing=execute('--once');
    assert.equal(missing.status,2);assert.match(missing.stderr,/not-ready/);assert.equal(missing.stdout,'');
  }finally{if(dirname(resolve(directory))!==resolve(tmpdir()))throw Error('cleanup_path_invalid');await rm(directory,{recursive:true,force:true});}
});
