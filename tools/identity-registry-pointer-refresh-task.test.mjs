import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { run } from './identity-registry-pointer-refresh-task.mjs';

const pin = (key, char) => ({ key, version_id: `v-${char}`, sha256: char.repeat(64) });
test('task wrapper emits only the refresh pins from a successful private runner result', () => {
  let seen = [];
  const value = { schema: 'cfo-identity-registry-pointer-refresh-result-v1', status: 'refreshed', manifest: pin('graph-trial/x/exports/manifest.json', 'a'), pointer: pin('graph-trial/x/exports/pointers/new.json', 'b'), expires_at: '2026-09-13T00:00:00.000Z', source_current: true, writes_performed: true };
  const result = run({ env: { CFO_IDENTITY_REGISTRY_POINTER_REFRESH_JSON: '{}', CFO_IDENTITY_REGISTRY_PORTS_JSON: '{}' }, spawn: (_node, args) => { seen = args; const output = args.at(-1); writeFileSync(output, JSON.stringify(value)); return { status: 0, stderr: '' }; } });
  assert.deepEqual(result, { schema: 'cfo-identity-registry-pointer-refresh-task-v1', status: 'refreshed', manifest: value.manifest, pointer: value.pointer, expires_at: value.expires_at });
  assert.equal(seen.includes('PRIVATE'), false);
});
test('task wrapper allowlists a source-currentness failure', () => {
  assert.throws(() => run({ env: { CFO_IDENTITY_REGISTRY_POINTER_REFRESH_JSON: '{}', CFO_IDENTITY_REGISTRY_PORTS_JSON: '{}' }, spawn: () => ({ status: 1, stderr: 'identity_pointer_refresh_source_not_current\n' }) }), { code: 'identity_pointer_refresh_source_not_current' });
});