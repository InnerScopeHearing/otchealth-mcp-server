import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityRegistrySnapshotStore, identityRegistrySnapshotStoreTest } from './identity-registry-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'identity-registry-store-'));
const request = { registry_id: 'cfo-registry', version: 'sirv_test_001', envelope: {
  schema: 'source-identity-registry-envelope-v1', snapshot: { entries: [], registry_id: 'cfo-registry', version: 'sirv_test_001' }, signature: 'synthetic' } };
try {
  const options = { rootDirectory: root, allowNonDurableWindows: process.platform === 'win32' };
  if (process.platform === 'win32') {
    await assert.rejects(() => createIdentityRegistrySnapshotStore({ rootDirectory: root }),
      /identity_registry_store_windows_durability_unproven/, 'Windows requires an explicit synthetic-only override');
  }
  await assert.rejects(() => createIdentityRegistrySnapshotStore({ ...options, rootDirectory: join(root, 'missing-root') }),
    /identity_registry_store_preprovisioned_root_required/, 'store root must be provisioned before durable use');
  const first = await createIdentityRegistrySnapshotStore(options);
  assert.equal(await first.publish(request), true, 'first immutable publish succeeds');
  assert.equal(await first.publish(request), false, 'duplicate immutable publish is rejected');
  assert.deepEqual(await first.read(request), { status: 'active', envelope: request.envelope }, 'stored envelope is read exactly');

  const restarted = await createIdentityRegistrySnapshotStore(options);
  assert.deepEqual(await restarted.read(request), { status: 'active', envelope: request.envelope }, 'record survives a fresh store instance');
  const competing = await Promise.all(Array.from({ length: 12 }, () => restarted.publish({ ...request, version: 'sirv_race_001' })));
  assert.equal(competing.filter(Boolean).length, 1, 'exactly one concurrent publisher wins');
  assert.equal(await restarted.revoke({ registry_id: request.registry_id, version: request.version }), true, 'durable revocation succeeds');
  assert.deepEqual(await restarted.read(request), { status: 'revoked' }, 'revocation overrides an existing snapshot');
  const afterRevocationRestart = await createIdentityRegistrySnapshotStore(options);
  assert.deepEqual(await afterRevocationRestart.read(request), { status: 'revoked' }, 'revocation survives restart');
  assert.equal(await afterRevocationRestart.publish(request), false, 'revoked version cannot be recreated');

  const racePath = join(root, request.registry_id, 'snapshots', 'sirv_race_001.json');
  await writeFile(racePath, '{"replaced":true}', 'utf8');
  await assert.rejects(() => afterRevocationRestart.read({ registry_id: request.registry_id, version: 'sirv_race_001' }),
    /identity_registry_store_integrity_failed/, 'external record replacement fails closed');
  await assert.rejects(() => first.publish({ ...request, version: 'sirv_invalid_json_001', envelope: { fn: () => true } }),
    /identity_registry_store_non_json_value/, 'non-JSON envelopes are rejected before persistence');
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => first.publish({ ...request, version: 'sirv_cycle_001', envelope: cyclic }),
    /identity_registry_store_json_cycle/, 'cyclic envelopes are rejected before traversal');
  const largePath = join(root, request.registry_id, 'snapshots', 'sirv_large_001.json');
  await writeFile(largePath, 'x'.repeat(identityRegistrySnapshotStoreTest.MAX_RECORD_BYTES + 1), 'utf8');
  await assert.rejects(() => first.read({ registry_id: request.registry_id, version: 'sirv_large_001' }),
    /identity_registry_store_record_too_large/, 'oversized corrupt records are rejected before allocation');
  process.stdout.write(JSON.stringify({ store: 'identity-registry', restart: true, concurrent_create_only: true, revocation: true, integrity_fail_closed: true }) + '\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
