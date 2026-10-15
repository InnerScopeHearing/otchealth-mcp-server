import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { DaytonaBinding, DaytonaMission } from './contract.js';
const api = await import('./transfer-bridge.js').catch(() => ({})) as Record<string, any>;
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const principal = 'a'.repeat(64), now = Date.now();
const binding: DaytonaBinding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: principal, sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const session: DaytonaMission = { provider: 'daytona', owner: 'cto', ownerSubjectHash: principal, sandboxId: binding.sandboxId, profileKey: binding.profileKey, sessionId: randomUUID(), expiresAt: now + 180000, actionsUsed: 1, actionBudget: 25, phase: 'ACTIVE', effectUnknown: true };
function fixture() {
  const id = randomUUID(), body = Buffer.from('public file fixture\n');
  const record = { id, owner: 'cto', ownerSubjectHash: principal, filename: 'notes.txt', contentType: 'text/plain', byteLength: body.length, sha256: hash(body), status: 'ready', expiresAt: now + 120000,
    scanReceipt: { verdict: 'clean', scanner: 'clamav', sha256: hash(body), byteLength: body.length, scannedAt: now, engineVersion: '1.5.4', signatureVersion: '28154', signaturesUpdatedAt: now - 1000 } };
  const calls: any[] = [];
  const remote = { run: async (...args: any[]) => { calls.push(['run', ...args]); const descriptor = args[3]; return descriptor?.phase === 'prepare' ? { prepared: true } : { fileReceipt: { status: 'attached', filename: record.filename, contentType: record.contentType, byteLength: record.byteLength, sha256: record.sha256 } }; }, upload: async (...args: any[]) => { calls.push(['upload', ...args]); } };
  return { id, body, record, calls, remote, files: { forUpload: async () => ({ record, body }) } };
}
test('upload copies exact cleared bytes, prepares private generated path, uploads once and verifies native attachment receipt', async () => {
  assert.equal(typeof api.DaytonaTransferBridge, 'function'); const f = fixture();
  const bridge = new api.DaytonaTransferBridge({ files: f.files, remote: f.remote });
  const result = await bridge.execute(binding, session, { type: 'upload', selector: '#file', fileId: f.id }, 20, principal);
  assert.equal(result.status, 'attached'); assert.deepEqual(f.calls.map(x => x[0]), ['run', 'upload', 'run']);
  assert.match(f.calls[1][3], /^\/home\/otcbrowser\/\.local\/share\/otchealth-browser\/profile-one\/uploads\/[a-f0-9-]{36}\/notes\.txt$/);
  assert.deepEqual(Buffer.from(f.calls[1][4]), f.body); assert.equal(f.calls[0][4].phase, 'prepare'); assert.equal(f.calls[2][4].phase, 'attach');
});
test('foreign, quarantined, missing scan, changed bytes, expired and suppressed transfers have zero remote effects', async () => {
  assert.equal(typeof api.DaytonaTransferBridge, 'function');
  for (const mode of ['foreign', 'quarantine', 'unscanned', 'changed', 'expired', 'suppressed']) {
    const f = fixture(); if (mode === 'foreign') f.record.ownerSubjectHash = 'c'.repeat(64);
    if (mode === 'quarantine') f.record.status = 'quarantined'; if (mode === 'unscanned') delete (f.record as any).scanReceipt;
    if (mode === 'changed') f.body.fill(0); if (mode === 'expired') f.record.expiresAt = now - 1;
    const bridge = new api.DaytonaTransferBridge({ files: f.files, remote: f.remote });
    await assert.rejects(bridge.execute(binding, { ...session, ...(mode === 'suppressed' ? { sensitiveOutputSuppressed: true } : {}) }, { type: 'upload', selector: '#file', fileId: f.id }, 20, principal));
    assert.equal(f.calls.length, 0, mode);
  }
});
test('upload acknowledgement loss or wrong browser hash is never replayed or accepted', async () => {
  assert.equal(typeof api.DaytonaTransferBridge, 'function'); const f = fixture();
  f.remote.upload = async (...args) => { f.calls.push(['upload', ...args]); throw new Error('PRIVATE_PROVIDER_DETAIL'); };
  const bridge = new api.DaytonaTransferBridge({ files: f.files, remote: f.remote });
  await assert.rejects(bridge.execute(binding, session, { type: 'upload', selector: '#file', fileId: f.id }, 20, principal));
  assert.deepEqual(f.calls.map(x => x[0]), ['run', 'upload']);
  const bad = fixture(); bad.remote.run = async (...args) => { bad.calls.push(['run',...args]); return args[3]?.phase==='prepare'?{prepared:true}:{fileReceipt:{status:'attached',filename:bad.record.filename,contentType:bad.record.contentType,byteLength:bad.record.byteLength,sha256:'b'.repeat(64)}}; };
  await assert.rejects(new api.DaytonaTransferBridge({files:bad.files,remote:bad.remote}).execute(binding,session,{type:'upload',selector:'#file',fileId:bad.id},20,principal));
  assert.deepEqual(bad.calls.map(x=>x[0]),['run','upload','run']);
});
test('directory transfer preserves actual nested paths and compares exact receipt fields independent of JSON key order',async()=>{
  const one=fixture(),two=fixture(); two.record.filename='other.txt';
  const records=new Map([[one.id,one],[two.id,two]]); const calls:any[]=[];
  const remote={upload:async(...args:any[])=>{calls.push(['upload',...args]);},run:async(...args:any[])=>{
    calls.push(['run',...args]); const descriptor=args[3];
    return descriptor.phase==='prepare'?{prepared:true}:{directoryReceipt:{status:'attached',directory:true,fileCount:2,byteLength:one.body.length+two.body.length,files:descriptor.files.map((f:any)=>({sha256:f.sha256,byteLength:f.byteLength,contentType:f.contentType,filename:f.filename,relativePath:f.relativePath}))}};
  }};
  const bridge=new api.DaytonaTransferBridge({remote,files:{forUpload:async(_o:string,id:string)=>{const f=records.get(id)!;return {record:f.record,body:f.body};}}});
  const result=await bridge.uploadDirectory(binding,session,'#folder',[{fileId:one.id,relativePath:'fixture/nested/notes.txt'},{fileId:two.id,relativePath:'fixture/other.txt'}],20,principal);
  assert.equal(result.fileCount,2);assert.deepEqual(calls.map(x=>x[0]),['run','upload','upload','run']);
  assert.equal(calls[1][3].endsWith('/fixture/nested/notes.txt'),true);assert.equal(calls[2][3].endsWith('/fixture/other.txt'),true);
});
test('named directory manifest guard preserves only a bounded real single-root nested tree, never accepts arbitrary paths', () => {
  assert.equal(typeof api.validateDaytonaDirectoryManifest, 'function'); const id = randomUUID();
  assert.deepEqual(api.validateDaytonaDirectoryManifest([{ fileId: id, relativePath: 'fixture/nested/metrics.txt' }]), [{ fileId: id, relativePath: 'fixture/nested/metrics.txt' }]);
  for (const path of ['/etc/passwd', '../escape.txt', 'fixture/.secret.txt', 'fixture/x/../../evil.txt', 'fixture\\evil.txt', 'fixture//bad.txt']) assert.throws(() => api.validateDaytonaDirectoryManifest([{ fileId: id, relativePath: path }]));
  assert.throws(() => api.validateDaytonaDirectoryManifest([{ fileId: id, relativePath: 'one/a.txt' }, { fileId: randomUUID(), relativePath: 'two/b.txt' }]));
});
test('an oversized encoded directory request is rejected before any dispatcher or SDK effects',async()=>{
  const records=new Map<string,ReturnType<typeof fixture>>(),entries=[]; const remote=fixture().remote;let effects=0;
  for(let i=0;i<32;i++){const f=fixture();f.record.filename='n'+i+'-'.repeat(120)+'.txt';records.set(f.id,f);entries.push({fileId:f.id,relativePath:'r'.repeat(128)+'/'+'s'.repeat(128)+'/'+'t'.repeat(120)+'/'+f.record.filename});}
  const bridge=new api.DaytonaTransferBridge({files:{forUpload:async(_o:string,id:string)=>{const f=records.get(id)!;return {record:f.record,body:f.body};}},remote:{...remote,run:async()=>{effects++;return {prepared:true};},upload:async()=>{effects++;}}});
  await assert.rejects(bridge.uploadDirectory(binding,session,'#folder',entries,20,principal),(e:any)=>e.code==='daytona_directory_manifest_too_large');assert.equal(effects,0);
});
test('actual PNG is structurally decoded then persisted under exact principal; storage-only fields never escape', async () => {
  const f = fixture(); const stored: any[] = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';
  const bridge = new api.DaytonaTransferBridge({ remote: { ...f.remote, run: async () => ({ capture: { contentType: 'image/png', data: png } }) },
    captures: { createCapture: async (owner: string, id: string, artifact: any, createdAt: number, subject: string) => {
      stored.push([owner,id,artifact,createdAt,subject]);
      return { id: 'bca_'+randomUUID(), owner, ownerSubjectHash: subject, sessionId: id, contentType: artifact.contentType, byteLength: artifact.body.length, sha256: artifact.sha256, createdAt, storageKey: 'PRIVATE_STORAGE_KEY' };
    } } });
  const result = await bridge.execute(binding,session,{type:'capture',request:{type:'screenshot',format:'png'}},20,principal);
  assert.equal(stored.length,1); assert.deepEqual(stored[0].slice(0,2),['cto',session.sessionId]); assert.equal(stored[0][4],principal);
  assert.equal(result.sha256,hash(Buffer.from(png,'base64'))); assert.equal(JSON.stringify(result).includes('PRIVATE_STORAGE_KEY'),false);
});
test('malformed/truncated captures, unsupported PDF and output suppression never create an artifact', async () => {
  let stores = 0, runs = 0;
  const f = fixture();
  const bridge = new api.DaytonaTransferBridge({remote:{...f.remote,run:async()=>{runs++;return {capture:{contentType:'image/png',data:'aW52YWxpZA=='}};}},captures:{createCapture:async()=>{stores++;throw new Error('must not store');}}});
  await assert.rejects(bridge.execute(binding,session,{type:'capture',request:{type:'screenshot'}},20,principal));
  await assert.rejects(bridge.execute(binding,session,{type:'capture',request:{type:'pdf'}},20,principal));
  await assert.rejects(bridge.execute(binding,{...session,sensitiveOutputSuppressed:true},{type:'capture',request:{type:'screenshot'}},20,principal));
  assert.equal(stores,0); assert.equal(runs,1);
});
