import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ListExecutionsArgs } from '../../n8n/full-client.js';
// full-client validates the process environment at import time. Set only synthetic placeholders so
// this isolated test can run without a .env file or any live service credentials.
process.env.CIO_SITE_ID ??= 'synthetic';
process.env.CIO_TRACK_KEY ??= 'synthetic';
process.env.CIO_APP_API_BEARER ??= 'synthetic';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 's'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 's'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 's'.repeat(32);

const {
  buildListExecutionsQuery,
  N8N_EXECUTION_LIST_MAX_LIMIT,
  N8N_EXECUTION_LIST_MAX_WINDOW_MS,
} = await import('../../n8n/full-client.js');
const {
  getN8nExecutionCountSummary,
  isN8nExecutionListAllowed,
  N8N_EXECUTION_LIST_INPUT_SHAPE,
  summarizeExecutionPage,
} = await import('./execution-list.js');

const validInput = {
  started_after: '2026-09-01T00:00:00.000Z',
  started_before: '2026-09-02T00:00:00.000Z',
  limit: 10,
};
const ctoContext = { callerAgent: 'cto', correlationId: 'synthetic-correlation' };

test('input schema requires explicit ISO bounds and a required bounded limit, with no raw-record options', () => {
  const schema = z.object(N8N_EXECUTION_LIST_INPUT_SHAPE).strict();
  assert.equal(schema.safeParse(validInput).success, true);
  assert.equal(schema.safeParse({ started_before: validInput.started_before, limit: 10 }).success, false);
  assert.equal(schema.safeParse({ started_after: validInput.started_after, limit: 10 }).success, false);
  assert.equal(schema.safeParse({ started_after: validInput.started_after, started_before: validInput.started_before }).success, false);
  assert.equal(schema.safeParse({ ...validInput, started_after: 'yesterday' }).success, false);
  assert.equal(schema.safeParse({ ...validInput, limit: 0 }).success, false);
  assert.equal(schema.safeParse({ ...validInput, limit: N8N_EXECUTION_LIST_MAX_LIMIT + 1 }).success, false);
  assert.equal(schema.safeParse({ ...validInput, include_data: true }).success, false);
  assert.equal(schema.safeParse({ ...validInput, cursor: 'SYNTHETIC_CURSOR' }).success, false);
  assert.deepEqual(Object.keys(N8N_EXECUTION_LIST_INPUT_SHAPE).sort(), ['limit', 'started_after', 'started_before']);
});

test('API query always carries both date bounds, the validated limit, and includeData=false', () => {
  const args: ListExecutionsArgs = {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: 10,
    correlationId: 'synthetic-correlation',
  };
  assert.deepEqual(buildListExecutionsQuery(args), {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: 10,
    includeData: false,
  });
});

test('API query rejects reversed, unbounded, oversized-window, or oversized-limit requests', () => {
  const base: ListExecutionsArgs = {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: 10,
  };
  assert.throws(() => buildListExecutionsQuery({ ...base, startedAfter: base.startedBefore }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, startedAfter: 'not-a-date' }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, startedBefore: new Date(Date.parse(base.startedAfter) + N8N_EXECUTION_LIST_MAX_WINDOW_MS + 1).toISOString() }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, limit: N8N_EXECUTION_LIST_MAX_LIMIT + 1 }), /n8n_execution_list_invalid_input/);
});

test('summary request is CTO-only and forwards only date bounds, limit, and forced data exclusion', async () => {
  let received: ListExecutionsArgs | undefined;
  const poison = 'SYNTHETIC_PROMPT_CUSTOMER_PAYLOAD_WORKFLOW_AND_EXECUTION_CONTENT';
  const raw = {
    data: [
      { id: 'SYNTHETIC_EXECUTION_ID_1', status: 'success', workflowId: 'SYNTHETIC_WORKFLOW_ID', workflowName: poison, data: { prompt: poison } },
      { id: 'SYNTHETIC_EXECUTION_ID_2', status: 'error', workflowName: poison, data: { customer: poison } },
      { id: 'SYNTHETIC_EXECUTION_ID_3', status: 'waiting', data: { payload: poison } },
      { id: 'SYNTHETIC_EXECUTION_ID_4', status: 'running', data: { prompt: poison } },
      { id: 'SYNTHETIC_EXECUTION_ID_5', status: 'synthetic-new-status', data: { content: poison } },
    ],
    nextCursor: 'SYNTHETIC_CURSOR_TOKEN',
  };
  const result = await getN8nExecutionCountSummary(validInput, ctoContext, async (args) => {
    received = args;
    return raw;
  });

  assert.deepEqual(received, {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: validInput.limit,
    correlationId: 'synthetic-correlation',
  });
  assert.deepEqual(result, {
    observed_count: 5,
    counts_by_status: { success: 1, error: 1, waiting: 1, running: 1, other: 1 },
    truncated: true,
  });
  assert.deepEqual(Object.keys(result).sort(), ['counts_by_status', 'observed_count', 'truncated']);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);

  for (const caller of ['developer', 'cfo', 'clo', 'coo', 'cro', 'exec', '']) {
    assert.equal(isN8nExecutionListAllowed(caller), false, caller);
  }
  assert.equal(isN8nExecutionListAllowed('cto'), true);
});

test('invalid bounds and limits fail before the executor is called', async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { data: [] };
  };
  await assert.rejects(
    getN8nExecutionCountSummary({ ...validInput, started_before: validInput.started_after }, ctoContext, executor),
    { message: 'n8n_execution_list_invalid_input' },
  );
  await assert.rejects(
    getN8nExecutionCountSummary({ ...validInput, limit: N8N_EXECUTION_LIST_MAX_LIMIT + 1 }, ctoContext, executor),
    { message: 'n8n_execution_list_invalid_input' },
  );
  await assert.rejects(
    getN8nExecutionCountSummary({
      ...validInput,
      started_before: new Date(Date.parse(validInput.started_after) + N8N_EXECUTION_LIST_MAX_WINDOW_MS + 1).toISOString(),
    }, ctoContext, executor),
    { message: 'n8n_execution_list_invalid_input' },
  );
  await assert.rejects(
    getN8nExecutionCountSummary(validInput, { ...ctoContext, callerAgent: 'coo' }, executor),
    { message: 'n8n_execution_list_forbidden' },
  );
  assert.equal(calls, 0);
});

test('upstream errors are replaced with a fixed safe error and never echo response content', async () => {
  const sensitiveSyntheticText = 'SYNTHETIC_ONLY_CUSTOMER_PROMPT_SECRET';
  await assert.rejects(
    getN8nExecutionCountSummary(validInput, ctoContext, async () => {
      throw new Error(`upstream response: ${sensitiveSyntheticText}`);
    }),
    (error: Error) => error.message === 'n8n_execution_list_request_failed' && !error.message.includes(sensitiveSyntheticText),
  );
});

test('malformed pages fail closed without returning IDs, names, payloads, or prompts', () => {
  const malformedPages: unknown[] = [
    null,
    { nextCursor: null },
    { data: [{ id: 'SYNTHETIC_ID', workflowName: 'SYNTHETIC_NAME' }] },
    { data: [{ status: 17, data: { prompt: 'SYNTHETIC_PROMPT' } }] },
    { data: [], nextCursor: { value: 'SYNTHETIC_CURSOR' } },
  ];
  for (const page of malformedPages) {
    assert.throws(
      () => summarizeExecutionPage(page, 1),
      (error: Error) => error.message === 'n8n_execution_list_invalid_response' && !error.message.includes('SYNTHETIC'),
    );
  }
  assert.throws(
    () => summarizeExecutionPage({ data: [{ status: 'success' }, { status: 'error' }] }, 1),
    { message: 'n8n_execution_list_invalid_response' },
  );
});
