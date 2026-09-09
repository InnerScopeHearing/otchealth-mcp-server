import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CIO_SITE_ID ||= 'test';
process.env.CIO_TRACK_KEY ||= 'test';
process.env.CIO_APP_API_BEARER ||= 'test';
process.env.PERPLEXITY_CONNECTOR_TOKEN ||= 'x'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ||= 'x'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ||= 'x'.repeat(32);

const { buildTaskListQuery } = await import('./ledger.js');
const { translate } = await import('./pg-sql.js');

test('task list personal exclusions translate as bound predicates before the database limit', () => {
  const built = buildTaskListQuery({
    owner_agent: 'developer',
    status: 'open',
    board: 'fleet',
    limit: 1,
    exclude_personal_legal: true,
  });
  const translated = translate({
    table: 'agentstate_tasks',
    query: built.query,
    parameters: built.parameters,
    pk: built.board,
    max: built.max,
  });

  assert.equal(
    translated.text,
    "SELECT doc AS doc FROM agentstate_tasks WHERE doc->>'board' = $1 AND doc->>'type' = $2 " +
      "AND doc->>'owner_agent' = $3 AND doc->>'status' = $4 AND doc->>'owner_agent' != $5 " +
      "AND doc->>'created_by' != $6 AND pk = $7 ORDER BY doc->>'created_at' DESC LIMIT 1",
  );
  assert.deepEqual(translated.values, [
    'fleet',
    'task',
    'developer',
    'open',
    'clo-personal',
    'clo-personal',
    'fleet',
  ]);
  assert.ok(translated.text.indexOf("doc->>'owner_agent' != $5") < translated.text.indexOf('LIMIT 1'));
  assert.ok(translated.text.indexOf("doc->>'created_by' != $6") < translated.text.indexOf('LIMIT 1'));
});

test('inline inequality literals remain bound and unsafe comparison syntax remains rejected', () => {
  const translated = translate({
    table: 'agentstate_tasks',
    query: "SELECT * FROM c WHERE c.owner_agent != 'clo-personal'",
    parameters: [],
    max: 10,
  });
  assert.equal(translated.text.includes('clo-personal'), false);
  assert.match(translated.text, /doc->>'owner_agent' != \$1/);
  assert.deepEqual(translated.values, ['clo-personal']);

  assert.throws(
    () => translate({
      table: 'agentstate_tasks',
      query: 'SELECT * FROM c WHERE c.owner_agent !== @owner',
      parameters: [{ name: '@owner', value: 'clo-personal' }],
      max: 10,
    }),
    /unsupported WHERE predicate/,
  );
});
