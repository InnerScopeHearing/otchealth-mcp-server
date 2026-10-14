import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildAcknowledgeQuery } = await import('./queue-postgres.js');

test('exact acknowledgment SQL is a single queue-and-ID delete with all liveness guards', () => {
  const query = buildAcknowledgeQuery('inbox-developer', '00000000-0000-4000-8000-000000000000');
  assert.match(query.text, /^\s*DELETE FROM agentstate_queue/);
  assert.match(query.text, /queue = \$1 AND message_id = \$2/);
  assert.match(query.text, /visible_at <= now\(\)/);
  assert.match(query.text, /expires_at > now\(\)/);
  assert.match(query.text, /enqueued_at > now\(\) - \(\$3 \* interval '1 second'\)/);
  assert.match(query.text, /dequeue_count <= \$4/);
  assert.deepEqual(query.values, ['inbox-developer', '00000000-0000-4000-8000-000000000000', 604800, 50]);
});
