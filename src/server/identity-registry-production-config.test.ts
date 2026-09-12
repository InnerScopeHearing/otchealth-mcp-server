import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { parseIdentityRegistryProductionConfig } from './identity-registry-production-config.js';
import { createProductionIdentityRegistryResolver } from './identity-registry-production.js';

const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value as object).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

function fixture() {
  const run = { ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'graph', scope: 'finance', run_version: 'v1', manifest_sha256: '2'.repeat(64) };
  return {
    schema: 'identity-registry-production-v1', registry_id: 'cfo-registry',
    authority: { schema: 'authenticated-structured-identity-authority-v1', adapter_id: 'synthetic-source-owner',
      source_system: 'synthetic-ledger', scope: 'cfo', version: 'v1' },
    binding: { authenticated_caller: 'cfo', room: 'finance', source_index: 'finance-cfo-source-docs',
      run: { ...run, run_id: 'run_' + hash(run) } },
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

test('production resolver proves storage preflight before returning a valid parsed configuration', async () => {
  assert.equal(createProductionIdentityRegistryResolver(undefined), undefined);
  assert.throws(() => createProductionIdentityRegistryResolver('{'), /identity_registry_production_configuration_invalid/);
  let preflights = 0;
  const resolver = createProductionIdentityRegistryResolver(JSON.stringify(fixture()), {
    createStore: () => ({
      preflight: async () => { preflights++; return { bucket: 'synthetic', prefix: 'synthetic', canonical_policy_sha256: '0'.repeat(64) }; },
      snapshots: {
        publish: async () => true,
        read: async () => ({ status: 'missing' as const }),
        revoke: async () => true,
      },
    }),
  });
  assert.ok(resolver);
  const resolved = await resolver!.resolve({ registry_id: 'cfo-registry', caller: {
    caller_hash: 'synthetic', raw_token: 'synthetic', caller_agent: 'cfo', connector_surface: true, m365_static_auth: false,
  } }, { signal: new AbortController().signal });
  assert.equal(preflights, 1);
  assert.equal(resolved?.storage_policy_ready, true);
  assert.equal(resolved?.registry_id, 'cfo-registry');
});
