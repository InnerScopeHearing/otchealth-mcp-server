import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recallHandler } from './recall.js';

test('memory_recall redacts an explicitly labeled value while preserving record identity', async () => {
  const id = '20261101-abcdef123456';
  const sentinel = 'SYNTHETIC_TOKEN_4z8K2m6Q9p3R7t1B';
  const result = await recallHandler(
    { query: `developer__${id}` },
    { correlationId: 'synthetic', callerHash: 'synthetic', dryRun: false, acknowledgeWarning: false, callerAgent: 'developer' },
    {
      isConfigured: () => true,
      readSharedAgent: async (agent) => [{
        id,
        ts: '2026-11-01T00:00:00Z',
        type: 'fact',
        text: `workspace secret ${sentinel}`,
        tags: [],
        agent,
      }],
      getRetractionSnapshot: async () => ({ byAgent: new Map(), verified: true }),
    },
  );
  const data = result.data as { matches: Array<{ id: string; text: string }> };
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0]!.id, id);
  assert.equal(data.matches[0]!.text, 'workspace secret [REDACTED: explicitly labeled secret]');
  assert.ok(!JSON.stringify(result).includes(sentinel));
});
