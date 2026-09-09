import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
test('TypeScript fallback loader rejects recoverable syntax errors before execution',()=>{
 const root=mkdtempSync(join(tmpdir(),'typescript-loader-syntax-'));
 try{const file=join(root,'invalid.ts');writeFileSync(file,'const value = (1; console.log("must-not-run");');const result=spawnSync(process.execPath,['--import',new URL('./typescript-test-loader.mjs',import.meta.url).href,file],{encoding:'utf8',windowsHide:true,timeout:15000});assert.notEqual(result.status,0);assert.match(result.stderr,/SyntaxError/);assert.doesNotMatch(result.stdout,/must-not-run/);}finally{rmSync(root,{recursive:true,force:true});}
});
