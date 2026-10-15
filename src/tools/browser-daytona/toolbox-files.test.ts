import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
const api = await import('./toolbox-files.js').catch(() => ({})) as Record<string, any>;
const binding = { provider: 'daytona', owner: 'cto', ownerSubjectHash: 'a'.repeat(64), sandboxId: 'sandbox-one', profileKey: 'profile-one', profilePath: '/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium', readinessReceiptSha256: 'b'.repeat(64) };
const path = '/home/otcbrowser/.local/share/otchealth-browser/profile-one/uploads/11111111-1111-4111-8111-111111111111/notes.txt';
const session = { provider:'daytona',owner:binding.owner,ownerSubjectHash:binding.ownerSubjectHash,sandboxId:binding.sandboxId,profileKey:binding.profileKey, sessionId: randomUUID(), expiresAt: Date.now()+180000, actionsUsed:1,actionBudget:25,effectUnknown:true,phase:'ACTIVE' };
test('actual multipart protocol sends exact bytes/generated path once, then fixed private permissions under trusted proxy origin', async () => {
  assert.equal(typeof api.uploadDaytonaControlledFile, 'function'); const calls: any[] = []; const bytes = Buffer.from('known public bytes');
  const promotions: any[] = [];
  await api.uploadDaytonaControlledFile({ binding, session, path, body: bytes, toolboxBaseUrl: 'https://proxy.app.daytona.io/toolbox', allowedOrigins: ['https://proxy.app.daytona.io'], token: 'synthetic-key', remaining: () => 1000,
    promote: async (payload: any) => { promotions.push(payload); return { staged:true,sha256:payload.sha256,byteLength:payload.byteLength }; },
    fetchImpl: async (url: string, init: RequestInit) => { calls.push([url, init]); return Response.json({ errors: null }); } });
  assert.equal(calls.length, 3); assert.equal(new URL(calls[0][0]).pathname,'/toolbox/sandbox-one/files/folder'); assert.equal(calls[1][0], 'https://proxy.app.daytona.io/toolbox/sandbox-one/files/bulk-upload');
  const form = calls[1][1].body as FormData; assert.match(String(form.get('files[0].path')), /^\/tmp\/otc-browser-upload-[a-f0-9-]{36}\/payload.bin$/);
  assert.deepEqual(Buffer.from(await (form.get('files[0].file') as Blob).arrayBuffer()), bytes);
  const permissions = new URL(calls[2][0]); assert.equal(permissions.pathname, '/toolbox/sandbox-one/files/permissions');
  assert.equal(permissions.searchParams.get('path'),form.get('files[0].path')); assert.equal(permissions.searchParams.has('owner'),false); assert.equal(permissions.searchParams.get('mode'), '600');
  assert.equal(promotions.length,1); assert.equal(promotions[0].profileKey,binding.profileKey); assert.equal(promotions[0].sessionId,session.sessionId); assert.equal(promotions[0].relativePath,'notes.txt');
  for (const [, init] of calls) { assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, 'Bearer synthetic-key'); }
});
test('foreign paths/origins and ambiguous transfer are never forwarded or retried', async () => {
  assert.equal(typeof api.uploadDaytonaControlledFile, 'function'); let calls = 0;
  const base = { binding, session, path, body: Buffer.from('known'), toolboxBaseUrl: 'https://proxy.app.daytona.io/toolbox', allowedOrigins: ['https://proxy.app.daytona.io'], token: 'synthetic-key', remaining: () => 1000, promote:async()=>{throw new Error('must not promote');}, fetchImpl: async () => { calls++; return new Response('PRIVATE_PROVIDER_ERROR', { status: 503 }); } };
  for (const changes of [{ path: '/etc/passwd' }, { path: path.replace('profile-one/uploads', 'other/uploads') }, { toolboxBaseUrl: 'https://attacker.example/toolbox' }]) await assert.rejects(api.uploadDaytonaControlledFile({ ...base, ...changes }));
  assert.equal(calls, 0); await assert.rejects(api.uploadDaytonaControlledFile(base)); assert.equal(calls, 1);
});
