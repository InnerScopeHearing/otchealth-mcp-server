import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKbSearch, type KbSearchDependencies } from './search.js';

test('ordinary open-index KB handler redacts labeled synthetic values', async () => {
  const dependencies = {
    configured: () => true,
    search: async () => ({
      matches: [{ id: 'fixture-hit-1', text: 'credential: SYNTHETIC_CREDENTIAL_VALUE_12345' }],
      mode: 'fixture',
    }),
    tag: (matches: unknown[]) => matches,
  } as unknown as KbSearchDependencies;

  const result = await handleKbSearch({ index: 'commons-company-journal', query: 'synthetic query' }, dependencies);
  const serialized = JSON.stringify(result);

  assert.equal(result && typeof result === 'object', true);
  assert.equal(serialized.includes('SYNTHETIC_CREDENTIAL_VALUE_12345'), false);
  assert.equal(serialized.includes('[REDACTED: explicitly labeled secret]'), true);
  assert.equal(serialized.includes('fixture-hit-1'), true);
});
