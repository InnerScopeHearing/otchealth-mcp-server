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
  N8N_EXECUTION_LIST_MAX_PAGES,
  N8N_EXECUTION_LIST_MAX_WINDOW_MS,
  N8N_EXECUTION_LIST_SCAN_BUDGET_MS,
} = await import('../../n8n/full-client.js');
const {
  getN8nExecutionCountSummary,
  isN8nExecutionListAllowed,
  N8N_EXECUTION_LIST_INPUT_SHAPE,
  scanExecutionPage,
} = await import('./execution-list.js');

const validInput = {
  started_after: '2026-09-01T00:00:00.000Z',
  started_before: '2026-09-02T00:00:00.000Z',
  limit: 10,
};
const window = { afterMs: Date.parse(validInput.started_after), beforeMs: Date.parse(validInput.started_before) };
const ctoContext = { callerAgent: 'cto', correlationId: 'synthetic-correlation' };
const POISON = 'SYNTHETIC_PROMPT_CUSTOMER_PAYLOAD_WORKFLOW_AND_EXECUTION_CONTENT';

/** The only query parameters GET /api/v1/executions accepts; anything else is a 400 upstream. */
const N8N_SUPPORTED_EXECUTION_QUERY_PARAMS = ['includeData', 'status', 'workflowId', 'projectId', 'limit', 'cursor'];

function exec(status: string, startedAt?: string): Record<string, unknown> {
  return {
    id: 'SYNTHETIC_EXECUTION_ID',
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    workflowId: 'SYNTHETIC_WORKFLOW_ID',
    workflowName: POISON,
    data: { prompt: POISON },
  };
}

function freshCounts() {
  return { success: 0, error: 0, waiting: 0, running: 0, other: 0 };
}

test('input schema requires explicit ISO bounds and a required bounded page size, with no raw-record options', () => {
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

test('REGRESSION: the upstream query never carries date bounds (n8n rejects them with a 400) and only uses supported params', () => {
  const args: ListExecutionsArgs = {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: 10,
    correlationId: 'synthetic-correlation',
  };
  const query = buildListExecutionsQuery(args);
  assert.deepEqual(query, { limit: 10, includeData: false });
  assert.equal('startedAfter' in query, false);
  assert.equal('startedBefore' in query, false);

  const withCursor = buildListExecutionsQuery({ ...args, cursor: 'SYNTHETIC_CURSOR_TOKEN' });
  assert.deepEqual(withCursor, { limit: 10, includeData: false, cursor: 'SYNTHETIC_CURSOR_TOKEN' });
  for (const key of Object.keys(withCursor)) {
    assert.ok(N8N_SUPPORTED_EXECUTION_QUERY_PARAMS.includes(key), `unsupported n8n query parameter: ${key}`);
  }
});

test('API query rejects reversed, unbounded, oversized-window, oversized-limit, or malformed-cursor requests', () => {
  const base: ListExecutionsArgs = {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: 10,
  };
  assert.throws(() => buildListExecutionsQuery({ ...base, startedAfter: base.startedBefore }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, startedAfter: 'not-a-date' }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, startedBefore: new Date(Date.parse(base.startedAfter) + N8N_EXECUTION_LIST_MAX_WINDOW_MS + 1).toISOString() }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, limit: N8N_EXECUTION_LIST_MAX_LIMIT + 1 }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, cursor: '' }), /n8n_execution_list_invalid_input/);
  assert.throws(() => buildListExecutionsQuery({ ...base, cursor: 'x'.repeat(2049) }), /n8n_execution_list_invalid_input/);
});

test('single page: counts only executions that started inside the inclusive window and leaks nothing else', async () => {
  const calls: ListExecutionsArgs[] = [];
  const page = {
    data: [
      exec('success', '2026-09-01T10:00:00.000Z'),
      exec('error', '2026-09-01T11:00:00.000Z'),
      exec('waiting', '2026-09-01T12:00:00.000Z'),
      exec('running', '2026-09-01T13:00:00.000Z'),
      exec('synthetic-new-status', '2026-09-01T14:00:00.000Z'),
      exec('success', validInput.started_after),
      exec('success', validInput.started_before),
      exec('success', '2026-09-02T00:00:00.001Z'),
      exec('success'),
    ],
    nextCursor: null,
  };
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 20 }, ctoContext, async (args) => {
    calls.push(args);
    return page;
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    startedAfter: validInput.started_after,
    startedBefore: validInput.started_before,
    limit: 20,
    correlationId: 'synthetic-correlation',
  });
  assert.deepEqual(result, {
    observed_count: 7,
    counts_by_status: { success: 3, error: 1, waiting: 1, running: 1, other: 1 },
    truncated: false,
    scanned_count: 9,
  });
  assert.deepEqual(Object.keys(result).sort(), ['counts_by_status', 'observed_count', 'scanned_count', 'truncated']);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
  assert.equal(JSON.stringify(result).includes(POISON), false);

  for (const caller of ['developer', 'cfo', 'clo', 'coo', 'cro', 'exec', '']) {
    assert.equal(isN8nExecutionListAllowed(caller), false, caller);
  }
  assert.equal(isN8nExecutionListAllowed('cto'), true);
});

test('multi page scan: skips newer pages, follows cursors, stops at the first page entirely before the window', async () => {
  const pages = [
    { data: [exec('success', '2026-09-03T00:00:00.000Z'), exec('error', '2026-09-02T12:00:00.000Z'), exec('success', '2026-09-02T00:00:00.001Z')], nextCursor: 'c1' },
    { data: [exec('success', validInput.started_before), exec('error', '2026-09-01T12:00:00.000Z'), exec('success')], nextCursor: 'c2' },
    { data: [exec('waiting', validInput.started_after), exec('success', '2026-08-31T23:59:59.999Z')], nextCursor: 'c3' },
    { data: [exec('success', '2026-08-31T20:00:00.000Z'), exec('error', '2026-08-30T00:00:00.000Z')], nextCursor: 'c4-never-followed' },
  ];
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 3 }, ctoContext, async (args) => {
    calls.push(args);
    return pages[calls.length - 1];
  });

  assert.deepEqual(calls.map((c) => c.cursor), [undefined, 'c1', 'c2', 'c3']);
  assert.ok(calls.every((c) => c.limit === 3 && c.correlationId === 'synthetic-correlation'));
  assert.deepEqual(result, {
    observed_count: 3,
    counts_by_status: { success: 1, error: 1, waiting: 1, running: 0, other: 0 },
    truncated: false,
    scanned_count: 10,
  });
});

test('a first page that lies entirely before the window ends the scan immediately with zero counts', async () => {
  let calls = 0;
  const result = await getN8nExecutionCountSummary(validInput, ctoContext, async () => {
    calls += 1;
    return { data: [exec('success', '2026-08-01T00:00:00.000Z')], nextCursor: 'SYNTHETIC_CURSOR_TOKEN' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { observed_count: 0, counts_by_status: freshCounts(), truncated: false, scanned_count: 1 });
});

test('the scan is capped by page count and reports truncated=true instead of running away', async () => {
  let calls = 0;
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 1 }, ctoContext, async () => {
    calls += 1;
    return { data: [exec('success', '2026-09-01T10:00:00.000Z')], nextCursor: `c${calls}` };
  });
  assert.equal(calls, N8N_EXECUTION_LIST_MAX_PAGES);
  assert.equal(result.truncated, true);
  assert.equal(result.observed_count, N8N_EXECUTION_LIST_MAX_PAGES);
  assert.equal(result.scanned_count, N8N_EXECUTION_LIST_MAX_PAGES);
});

test('the scan is capped by wall clock and reports truncated=true', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const result = await getN8nExecutionCountSummary(
    { ...validInput, limit: 1 },
    ctoContext,
    async () => {
      calls += 1;
      clock += N8N_EXECUTION_LIST_SCAN_BUDGET_MS + 1;
      return { data: [exec('error', '2026-09-01T10:00:00.000Z')], nextCursor: `c${calls}` };
    },
    () => clock,
  );
  assert.equal(calls, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.counts_by_status, { ...freshCounts(), error: 1 });
});

test('an upstream that repeats its cursor fails closed instead of looping', async () => {
  let calls = 0;
  await assert.rejects(
    getN8nExecutionCountSummary(validInput, ctoContext, async () => {
      calls += 1;
      return { data: [exec('success', '2026-09-01T10:00:00.000Z')], nextCursor: 'SYNTHETIC_SAME_CURSOR' };
    }),
    { message: 'n8n_execution_list_invalid_response' },
  );
  assert.equal(calls, 2);
});

test('invalid bounds and limits fail before the executor is called', async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { data: [], nextCursor: null };
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
  // An error on a later page is sanitised the same way.
  let calls = 0;
  await assert.rejects(
    getN8nExecutionCountSummary(validInput, ctoContext, async () => {
      calls += 1;
      if (calls === 2) throw new Error(`upstream response: ${sensitiveSyntheticText}`);
      return { data: [exec('success', '2026-09-03T00:00:00.000Z')], nextCursor: `c${calls}` };
    }),
    { message: 'n8n_execution_list_request_failed' },
  );
});

test('malformed pages fail closed without returning IDs, names, payloads, or prompts', () => {
  const malformedPages: unknown[] = [
    null,
    [],
    { nextCursor: null },
    { data: [{ status: 'success' }] },
    { data: [], nextCursor: undefined },
    { data: [{ id: 'SYNTHETIC_ID', workflowName: 'SYNTHETIC_NAME' }], nextCursor: null },
    { data: [{ status: 17, data: { prompt: 'SYNTHETIC_PROMPT' } }], nextCursor: null },
    { data: [{ status: '' }], nextCursor: null },
    { data: [null], nextCursor: null },
    { data: [], nextCursor: { value: 'SYNTHETIC_CURSOR' } },
    { data: [], nextCursor: '' },
    { data: [], nextCursor: 'x'.repeat(2049) },
  ];
  for (const page of malformedPages) {
    assert.throws(
      () => scanExecutionPage(page, 1, window, freshCounts()),
      (error: Error) => error.message === 'n8n_execution_list_invalid_response' && !error.message.includes('SYNTHETIC'),
    );
  }
  assert.throws(
    () => scanExecutionPage({ data: [{ status: 'success' }, { status: 'error' }], nextCursor: null }, 1, window, freshCounts()),
    { message: 'n8n_execution_list_invalid_response' },
  );
});

test('a valid page reports its next cursor to the scanner but never exposes it in the summary', async () => {
  const scan = scanExecutionPage(
    { data: [exec('success', '2026-09-01T10:00:00.000Z')], nextCursor: 'SYNTHETIC_CURSOR_TOKEN' },
    1,
    window,
    freshCounts(),
  );
  assert.equal(scan.nextCursor, 'SYNTHETIC_CURSOR_TOKEN');
  assert.equal(scanExecutionPage({ data: [], nextCursor: null }, 1, window, freshCounts()).nextCursor, null);

  const result = await getN8nExecutionCountSummary(validInput, ctoContext, async (args) =>
    args.cursor === undefined
      ? { data: [exec('success', '2026-09-01T10:00:00.000Z')], nextCursor: 'SYNTHETIC_CURSOR_TOKEN' }
      : { data: [], nextCursor: null },
  );
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_CURSOR_TOKEN'), false);
});
