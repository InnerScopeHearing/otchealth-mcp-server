import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { parseIdentityRegistryProductionConfig } from './identity-registry-production-config.js';

function fixture() {
  return {
    schema: 'identity-registry-production-v1', registry_id: 'cfo-registry',
    authority: { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'synthetic-source-owner',
      source_system: 'synthetic-ledger', scope: 'cfo', version: 'v1' },
    binding: { authenticated_caller: 'cfo', room: 'finance', source_index: 'finance-cfo-source-docs',
      run: { ref_version: 'neptune-trial-active-run-ref-v1', run_id: 'run_' + '1'.repeat(64),
        purpose: 'graph', scope: 'finance', run_version: 'v1', manifest_sha256: '2'.repeat(64) } },
    public_key: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    partition_manifest_version: 'sirm_' + '3'.repeat(64),
    source: { prefix: 'graph-trial/source-authority',
      manifest: { key: 'graph-trial/source-authority/manifest', version_id: 'synthetic-v1', sha256: '4'.repeat(64) },
      pointer: { key: 'graph-trial/source-authority/current' },
      catalog: { catalog_version: 'synthetic-v1', catalog_sha256: '5'.repeat(64) } },
    storage: { prefix: 'graph-trial/registry-store', approved_policy_canonical_sha256: '6'.repeat(64),
      approved_storage_scope_sha256: '7'.repeat(64), sse: { algorithm: 'AES256' } },
  };
}
test('production config remains absent unless explicitly configured and freezes valid references', () => {
  assert.equal(parseIdentityRegistryProductionConfig(undefined), null);
  assert.equal(parseIdentityRegistryProductionConfig('  '), null);
  const config = parseIdentityRegistryProductionConfig(JSON.stringify(fixture()));
  assert.equal(config?.registry_id, 'cfo-registry');
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config?.source.manifest));
});
test('production config rejects cross-ring, unsafe storage scopes, private keys and unexpected properties without echo', () => {
  const mutations = [
    (v: ReturnType<typeof fixture>) => { v.binding.authenticated_caller = 'clo'; },
    (v: ReturnType<typeof fixture>) => { v.source.manifest.key = 'other-ring/manifest'; },
    (v: ReturnType<typeof fixture>) => { v.source.manifest.key = 'graph-trial/source-authority/../manifest'; },
    (v: ReturnType<typeof fixture>) => { v.storage.prefix = v.source.prefix; },
    (v: ReturnType<typeof fixture>) => { v.public_key = '-----BEGIN PRIVATE KEY-----\nsynthetic-test-placeholder'; },
    (v: ReturnType<typeof fixture>) => { Object.assign(v, { unexpected: 'synthetic-do-not-echo' }); },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => parseIdentityRegistryProductionConfig(JSON.stringify(value)), {
      message: 'identity_registry_production_configuration_invalid',
    });
  }
});
