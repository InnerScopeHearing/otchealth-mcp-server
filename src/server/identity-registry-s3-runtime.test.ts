import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createIdentityRegistryS3Runtime } from './identity-registry-s3-runtime.js';

const resource = 'arn:aws:s3:::synthetic-registry-store/graph-trial/identity-registry/identity-registries/*';
const policy = { Statement: [
  { Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'], Effect: 'Deny', Principal: '*', Resource: resource },
  { Action: 's3:PutObject', Condition: { Null: { 's3:if-none-match': 'true' } }, Effect: 'Deny', Principal: '*', Resource: resource },
], Version: '2012-10-17' };
const policyText = JSON.stringify(policy);
const policyHash = createHash('sha256').update(policyText).digest('hex');
const scopeHash = createHash('sha256').update(JSON.stringify({ bucket: 'synthetic-registry-store', policy_sha256: policyHash, prefix: 'graph-trial/identity-registry' })).digest('hex');
const credentials = { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret' };

function runtime(overrides: { policyText?: string; versioning?: string; approvedPolicyHash?: string; fetch?: typeof fetch; resolveCredentials?: () => Promise<typeof credentials> } = {}) {
  const calls: string[] = [];
  return { calls, value: createIdentityRegistryS3Runtime({
    bucket: 'synthetic-registry-store', prefix: 'graph-trial/identity-registry', region: 'us-east-1',
    approvedPolicyCanonicalSha256: overrides.approvedPolicyHash ?? policyHash,
    approvedStorageScopeSha256: overrides.approvedPolicyHash ? createHash('sha256').update(JSON.stringify({ bucket: 'synthetic-registry-store', policy_sha256: overrides.approvedPolicyHash, prefix: 'graph-trial/identity-registry' })).digest('hex') : scopeHash,
    resolveCredentials: overrides.resolveCredentials ?? (async () => credentials),
    signRequest: input => ({ headers: { ...(input.extraHeaders ?? {}), authorization: 'synthetic' } }),
    fetch: overrides.fetch ?? (async (url: string | URL) => { calls.push(String(url)); const parsed = new URL(String(url));
      if (parsed.searchParams.has('versioning')) return new Response(overrides.versioning ?? '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>');
      if (parsed.searchParams.has('policy')) return new Response(overrides.policyText ?? policyText);
      return new Response('', { status: 404 }); }), requestTimeoutMs: 1000,
  }) };
}

test('runtime preflight proves the reviewed policy bytes and bucket versioning', async () => {
  const fixture = runtime();
  const evidence = await fixture.value.preflight(new AbortController().signal);
  assert.deepEqual(evidence, { bucket: 'synthetic-registry-store', prefix: 'graph-trial/identity-registry', canonical_policy_sha256: policyHash });
  assert.equal(fixture.calls.length, 2);
});
test('runtime rejects reviewed policies without unconditional deletion and conditional-create enforcement', async () => {
  for (const value of [
    { ...policy, Statement: [policy.Statement[0]] },
    { ...policy, Statement: policy.Statement.map(row => ({ ...row, Principal: 'synthetic-other-principal' })) },
    { ...policy, Statement: policy.Statement.map((row, i) => i === 0 ? { ...row, Condition: { Bool: { 'aws:SecureTransport': 'false' } } } : row) },
  ]) {
    const canonical = (item: any): string => item === null || typeof item !== 'object' ? JSON.stringify(item) : Array.isArray(item)
      ? '[' + item.map(canonical).join(',') + ']' : '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}';
    const text = canonical(value), approvedPolicyHash = createHash('sha256').update(text).digest('hex');
    await assert.rejects(runtime({ policyText: text, approvedPolicyHash }).value.preflight(new AbortController().signal),
      /identity_registry_s3_(immutable_scope|create_only_policy)_required/);
  }
});
test('runtime rejects truncated bodies and immediately settles caller cancellation of ignored dependencies', async () => {
  await assert.rejects(runtime({ fetch: async () => new Response('<Status>Enabled</Status>', { headers: { 'content-length': '1000' } }) })
    .value.preflight(new AbortController().signal), /identity_registry_s3_response_length_invalid/);
  for (const override of [
    { resolveCredentials: () => new Promise<never>(() => undefined) },
    { fetch: () => new Promise<never>(() => undefined) },
  ]) {
    const controller = new AbortController();
    const pending = runtime(override).value.preflight(controller.signal);
    setTimeout(() => controller.abort(), 10);
    const before = Date.now();
    await assert.rejects(pending, /identity_registry_s3_deadline/);
    assert.ok(Date.now() - before < 500);
  }
});
test('runtime refuses every PUT lacking the exact asterisk create condition before signing or transport', async () => {
  const f = runtime();
  for (const headers of [{}, { 'if-none-match': 'synthetic-etag' }]) {
    await assert.rejects(f.value.request({ method: 'PUT', key: 'graph-trial/identity-registry/identity-registries/test/snapshots/v1.json',
      headers, body: '{}', signal: new AbortController().signal }), /identity_registry_s3_conditional_create_required/);
  }
  assert.equal(f.calls.length, 0);
});
test('runtime preflight fails closed for suspended versioning or changed policy', async () => {
  await assert.rejects(runtime({ versioning: '<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>' }).value.preflight(new AbortController().signal), /identity_registry_s3_versioning_required/);
  await assert.rejects(runtime({ policyText: '{"Statement":[{"Effect":"Allow"}],"Version":"2012-10-17"}' }).value.preflight(new AbortController().signal), /identity_registry_s3_policy_mismatch/);
});
