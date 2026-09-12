import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import { createCfoIdentityRegistryKmsSigner, createExplicitExportImmutableStore } from './identity-registry-explicit-export-ports.js';

test('KMS signer obtains only an Ed25519 public key and verifies the returned signature', async () => {
  const keys = generateKeyPairSync('ed25519');
  const keyId = 'arn:aws:kms:us-east-1:900915535335:key/11111111-1111-4111-8111-111111111111';
  const calls: string[] = [];
  const signer = await createCfoIdentityRegistryKmsSigner({
    region: 'us-east-1', keyId, resolveCredentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }),
    signRequest: input => ({ headers: input.extraHeaders ?? {} }),
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers); const target = headers.get('x-amz-target')!; calls.push(target);
      if (target === 'TrentService.GetPublicKey') return new Response(JSON.stringify({ KeyId: keyId, KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ED25519_SHA_512'], PublicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }), { status: 200 });
      const body = JSON.parse(String(init.body)) as { Message: string };
      assert.equal(body.MessageType, 'RAW');
      assert.equal(body.SigningAlgorithm, 'ED25519_SHA_512');
      return new Response(JSON.stringify({ KeyId: keyId, SigningAlgorithm: 'ED25519_SHA_512', Signature: sign(null, Buffer.from(body.Message, 'base64'), keys.privateKey).toString('base64') }), { status: 200 });
    },
  });
  const payload = Buffer.from('synthetic signed payload');
  const signature = await signer.sign(payload);
  assert.equal(verify(null, payload, signer.publicKey, signature), true);
  assert.deepEqual(calls, ['TrentService.GetPublicKey', 'TrentService.Sign']);
  assert.equal(signer.publicKey.includes('PRIVATE'), false);
  assert.equal(signer.maxMessageBytes, 4096);
  await assert.rejects(() => signer.sign(Buffer.alloc(4097)), { code: 'identity_export_signature_invalid' });
  assert.equal(calls.length, 2, 'oversized RAW input is refused before a KMS Sign request');
});

test('KMS signer rejects a mutable alias result whose immutable key ARN differs from the configured pin', async () => {
  const key = generateKeyPairSync('ed25519');
  const expected = 'arn:aws:kms:us-east-1:900915535335:key/22222222-2222-4222-8222-222222222222';
  await assert.rejects(() => createCfoIdentityRegistryKmsSigner({
    region: 'us-east-1', keyId: expected, resolveCredentials: async () => ({ accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }),
    signRequest: input => ({ headers: input.extraHeaders ?? {} }),
    fetch: async () => new Response(JSON.stringify({ KeyId: 'arn:aws:kms:us-east-1:900915535335:key/33333333-3333-4333-8333-333333333333', KeySpec: 'ECC_NIST_EDWARDS25519', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ED25519_SHA_512'], PublicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }), { status: 200 }),
  }), { code: 'identity_export_kms_unavailable' });
});

test('immutable source export store conditionally creates then reconciles an exact retry', async () => {
  const objects = new Map<string, { body: Buffer; version: string }>(); let puts = 0, preflights = 0;
  const reply = (status: number, body = Buffer.alloc(0), version?: string) => ({ status, body, headers: new Headers(version ? { 'x-amz-version-id': version, 'x-amz-server-side-encryption': 'AES256' } : {}) });
  const runtime = {
    preflight: async () => { preflights++; return { bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix: 'graph-trial/cfo-identity-pilot', canonical_policy_sha256: 'a'.repeat(64) }; },
    request: async (input: { method: 'GET' | 'PUT'; key: string; versionId?: string; body?: string; headers?: Record<string, string> }) => {
      const current = objects.get(input.key);
      if (input.method === 'GET') {
        if (!current || (input.versionId !== undefined && input.versionId !== current.version)) return reply(404);
        return reply(200, current.body, current.version);
      }
      assert.equal(input.headers?.['if-none-match'], '*');
      if (current) return reply(412);
      const item = { body: Buffer.from(input.body!, 'utf8'), version: `v-${++puts}` }; objects.set(input.key, item);
      return reply(200, Buffer.alloc(0), item.version);
    },
  };
  const store = createExplicitExportImmutableStore({ bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix: 'graph-trial/cfo-identity-pilot', region: 'us-east-1',
    approvedPolicyCanonicalSha256: 'a'.repeat(64), approvedStorageScopeSha256: createHash('sha256').update(JSON.stringify({ bucket: 'otchealth-finance-legal-dr-55c84f6b', prefix: 'graph-trial/cfo-identity-pilot', policy_sha256: 'a'.repeat(64) })).digest('hex'),
    sse: { algorithm: 'AES256' }, createRuntime: () => runtime as never });
  const key = 'graph-trial/cfo-identity-pilot/pages/0.json', body = Buffer.from('{"synthetic":true}');
  assert.deepEqual(await store.putImmutable({ key, body }), { version_id: 'v-1' });
  assert.deepEqual(await store.putImmutable({ key, body }), { version_id: 'v-1' });
  await assert.rejects(() => store.putImmutable({ key, body: Buffer.from('{"synthetic":false}') }), { code: 'identity_export_store_conflict' });
  assert.equal(puts, 1);
  assert.equal(preflights, 3);
});
