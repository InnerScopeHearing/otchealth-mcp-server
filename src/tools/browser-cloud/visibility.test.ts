import test from 'node:test';
import assert from 'node:assert/strict';
import { addCtoExistingProfileTools } from './visibility.js';

test('persistent-profile tools are catalogued only for default CTO connector requests', () => {
  const names = ['browser_cloud_cto_profile_discover_existing', 'browser_cloud_cto_profile_bind_existing'];
  const cto = new Set<string>(); addCtoExistingProfileTools(cto, 'cto');
  assert.deepEqual(names.filter((name) => cto.has(name)), names);
  const other = new Set<string>(); addCtoExistingProfileTools(other, 'cfo');
  assert.deepEqual(names.filter((name) => other.has(name)), []);
  const override = new Set<string>(); addCtoExistingProfileTools(override, 'cto', 'brain_search');
  assert.deepEqual(names.filter((name) => override.has(name)), []);
});

test('a non-CTO explicit toolset cannot retain existing-profile tool names', () => {
  for (const lane of ['cfo', 'clo-personal', 'developer']) {
    const tools = new Set(['brain_search', 'browser_cloud_cto_profile_discover_existing', 'browser_cloud_cto_profile_bind_existing']);
    addCtoExistingProfileTools(tools, lane, 'browser_cloud_cto_profile_discover_existing,browser_cloud_cto_profile_bind_existing');
    assert.deepEqual([...tools], ['brain_search']);
  }
});
