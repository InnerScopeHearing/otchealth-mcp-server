import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPROVED_GATEWAY_ORIGIN, runIdentityRegistryProductionPreflight } from './identity-registry-production-preflight.mjs';

const tool = fileURLToPath(new URL('./identity-registry-production-preflight.mjs', import.meta.url));
const run = (args) => new Promise(resolve => {
  const child = spawn(process.execPath, [tool, ...args], { env: { ...process.env } });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.on('close', code => resolve({ code, value: JSON.parse(stdout) }));
});
const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const validConfig = () => {
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const runBase = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'graph', scope: 'finance', run_version: 'v1', manifest_sha256: '2'.repeat(64) };
  const run = { ...runBase, run_id: 'run_' + createHash('sha256').update(canonical(runBase)).digest('hex') };
  return { schema: 'identity-registry-production-v1', registry_id: 'cfo-registry',
    authority: { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'source-owner', source_system: 'source-system', scope: 'cfo', version: 'v1' },
    binding: { authenticated_caller: 'cfo', room: 'finance', source_index: 'finance-cfo-source-docs', run }, public_key: key,
    partition_manifest_version: 'sirm_' + '3'.repeat(64), source: { prefix: 'graph-trial/source-authority',
      manifest: { key: 'graph-trial/source-authority/manifest', version_id: 'v1', sha256: '4'.repeat(64) }, pointer: { key: 'graph-trial/source-authority/current' },
      catalog: { catalog_version: 'catalog-v1', catalog_sha256: '5'.repeat(64) } },
    storage: { prefix: 'graph-trial/registry-store', approved_policy_canonical_sha256: '6'.repeat(64), approved_storage_scope_sha256: '7'.repeat(64), sse: { algorithm: 'AES256' } } };
};

test('preflight validates the deployed schema without exposing public-key or pin fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-registry-preflight-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(validConfig()));
    const result = await run(['--config', path]);
    assert.equal(result.code, 0);
    assert.deepEqual(Object.keys(result.value).sort(), ['config_valid', 'live_probe', 'registry_config_sha256', 'schema', 'status']);
    assert.equal(result.value.status, 'config_valid');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preflight rejects private-key material without echoing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-registry-preflight-'));
  try {
    const path = join(directory, 'config.json');
    const secret = '-----BEGIN PRIVATE KEY-----not-a-real-key';
    await writeFile(path, secret);
    const result = await run(['--config', path]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.value, { schema: 'identity-registry-production-preflight-v1', status: 'blocked', code: 'private_key_material_rejected' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('command line rejects a caller-supplied gateway origin', async () => {
  const result = await run(['--gateway-origin', 'https://foreign.invalid']);
  assert.equal(result.code, 2);
  assert.deepEqual(result.value, { schema: 'identity-registry-production-preflight-v1', status: 'blocked', code: 'invalid_arguments' });
});

test('live probe uses only the approved origin and accepts the fixed success receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-registry-preflight-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(validConfig()));
    let requested = '';
    const output = await runIdentityRegistryProductionPreflight({
      configPath: path, checkLive: true, sourceBindingSha256: 'a'.repeat(64), token: 'synthetic-only',
      fetchImpl: async (url, init) => {
        requested = url;
        assert.equal(init.redirect, 'error');
        return new Response(JSON.stringify({ configured: true, valid_config: true, storage_policy_ready: true, coverage_ready: true, reason: 'coverage_checked' }), { status: 200 });
      },
    });
    assert.ok(requested.startsWith(APPROVED_GATEWAY_ORIGIN + '/graph-worker/v1/identity-registry/'));
    assert.equal(new URL(requested).origin, APPROVED_GATEWAY_ORIGIN);
    assert.equal(output.exitCode, 0);
    assert.equal(output.payload.status, 'ready');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live probe rejects oversized bodies and unknown reasons without reflecting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'identity-registry-preflight-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(validConfig()));
    const input = { configPath: path, checkLive: true, sourceBindingSha256: 'a'.repeat(64), token: 'synthetic-only' };
    const tooLarge = await runIdentityRegistryProductionPreflight({ ...input, fetchImpl: async () => new Response('x'.repeat(16 * 1024 + 1), { status: 200 }) });
    assert.deepEqual(tooLarge.payload, { schema: 'identity-registry-production-preflight-v1', status: 'blocked', code: 'readiness_response_invalid' });
    const unknown = 'foreign-upstream-message-do-not-reflect';
    const malformed = await runIdentityRegistryProductionPreflight({ ...input, fetchImpl: async () => new Response(JSON.stringify({ configured: true, valid_config: true, storage_policy_ready: true, coverage_ready: false, reason: unknown }), { status: 200 }) });
    assert.deepEqual(malformed.payload, { schema: 'identity-registry-production-preflight-v1', status: 'blocked', code: 'readiness_response_invalid' });
    assert.equal(JSON.stringify(malformed.payload).includes(unknown), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
