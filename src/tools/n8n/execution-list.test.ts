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
// Only the mocked-fetch tests at the end of this file use these two: a placeholder key, and a host on
// the reserved .invalid TLD so nothing here can ever reach a real n8n instance.
process.env.N8N_API_KEY ??= 'synthetic-n8n-api-key-for-unit-tests';
process.env.N8N_BASE_URL ??= 'https://n8n.synthetic.invalid';

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// limit-100 reliability (2026-10-07): n8n is never sent a page above 50; a page that times out is
// retried once at half the size (floor 10); a scan that runs out of time or keeps timing out returns
// what it gathered with truncated=true and a reason instead of failing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const {
  isN8nExecutionPageTimeout,
  listExecutions,
  N8nFullError,
  N8N_EXECUTION_LIST_MAX_PAGE_SIZE,
  N8N_EXECUTION_LIST_MIN_PAGE_SIZE,
  N8N_EXECUTION_PAGE_TIMEOUT_CODE,
  withCursorLimit,
} = await import('../../n8n/full-client.js');
const { __resetN8nReachabilityCache } = await import('../../n8n/reachability.js');
const { nextPageSizeAfterTimeout } = await import('./execution-list.js');

const apiArgs: ListExecutionsArgs = {
  startedAfter: validInput.started_after,
  startedBefore: validInput.started_before,
  limit: 100,
  correlationId: 'synthetic-correlation',
};

const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');
const decodeCursor = (cursor: string): unknown => JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));

/** What listExecutions() throws when n8n does not answer a page in time. */
function pageTimeout(): Error {
  return new N8nFullError({
    code: N8N_EXECUTION_PAGE_TIMEOUT_CODE,
    status: 0,
    message: 'SYNTHETIC_UPSTREAM_TIMEOUT_TEXT',
    nextStep: 'synthetic',
  });
}

/** One upstream page of `size` executions that all started inside the validInput window. */
function inWindowPage(size: number, nextCursor: string | null, status = 'success') {
  return { data: Array.from({ length: size }, () => exec(status, '2026-09-01T12:00:00.000Z')), nextCursor };
}

test('the input schema is unchanged: limit still accepts 1 to 100', () => {
  const schema = z.object(N8N_EXECUTION_LIST_INPUT_SHAPE).strict();
  assert.equal(schema.safeParse({ ...validInput, limit: 1 }).success, true);
  assert.equal(schema.safeParse({ ...validInput, limit: 100 }).success, true);
  assert.equal(schema.safeParse({ ...validInput, limit: 101 }).success, false);
  assert.deepEqual(Object.keys(N8N_EXECUTION_LIST_INPUT_SHAPE).sort(), ['limit', 'started_after', 'started_before']);
});

test('limit 100 is served as two pages of 50 and assembled into one summary', async () => {
  const calls: ListExecutionsArgs[] = [];
  const deadlines: Array<number | undefined> = [];
  const pages = [inWindowPage(50, 'c1'), inWindowPage(50, null, 'error')];
  const result = await getN8nExecutionCountSummary(
    { ...validInput, limit: 100 },
    ctoContext,
    async (args, opts) => {
      calls.push(args);
      deadlines.push(opts?.deadlineAtMs);
      return pages[calls.length - 1];
    },
    () => 1_000_000,
  );

  assert.deepEqual(calls.map((c) => c.limit), [50, 50]);
  assert.deepEqual(calls.map((c) => c.cursor), [undefined, 'c1']);
  assert.ok(calls.every((c) => c.limit <= N8N_EXECUTION_LIST_MAX_PAGE_SIZE));
  // Every request is given the scan's absolute deadline, so no attempt can run past the time budget.
  assert.deepEqual(deadlines, [1_000_000 + N8N_EXECUTION_LIST_SCAN_BUDGET_MS, 1_000_000 + N8N_EXECUTION_LIST_SCAN_BUDGET_MS]);
  assert.deepEqual(result, {
    observed_count: 100,
    counts_by_status: { ...freshCounts(), success: 50, error: 50 },
    truncated: false,
    scanned_count: 100,
    effective_page_size: 50,
  });
});

test('a limit at or below the cap is sent as asked and reports no page-size adjustment', async () => {
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: N8N_EXECUTION_LIST_MAX_PAGE_SIZE }, ctoContext, async (args) => {
    calls.push(args);
    return inWindowPage(3, null);
  });
  assert.deepEqual(calls.map((c) => c.limit), [N8N_EXECUTION_LIST_MAX_PAGE_SIZE]);
  assert.deepEqual(Object.keys(result).sort(), ['counts_by_status', 'observed_count', 'scanned_count', 'truncated']);
});

test('a page timeout is retried once at half the page size and the smaller size is kept for the pages after it', async () => {
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 50 }, ctoContext, async (args) => {
    calls.push(args);
    if (calls.length === 1) throw pageTimeout();
    return calls.length === 2 ? inWindowPage(25, 'c1') : inWindowPage(25, null);
  });

  assert.deepEqual(calls.map((c) => c.limit), [50, 25, 25]);
  assert.deepEqual(calls.map((c) => c.cursor), [undefined, undefined, 'c1']);
  assert.deepEqual(result, {
    observed_count: 50,
    counts_by_status: { ...freshCounts(), success: 50 },
    truncated: false,
    scanned_count: 50,
    effective_page_size: 25,
    page_timeout_retries: 1,
  });
  assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
});

test('a page that times out is re-requested with the SAME cursor at half the size', async () => {
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext, async (args) => {
    calls.push(args);
    if (calls.length === 1) return inWindowPage(50, 'c1');
    if (calls.length === 2) throw pageTimeout();
    return inWindowPage(25, null);
  });

  assert.deepEqual(calls.map((c) => c.limit), [50, 50, 25]);
  assert.deepEqual(calls.map((c) => c.cursor), [undefined, 'c1', 'c1']);
  assert.deepEqual(result, {
    observed_count: 75,
    counts_by_status: { ...freshCounts(), success: 75 },
    truncated: false,
    scanned_count: 75,
    effective_page_size: 25,
    page_timeout_retries: 1,
  });
});

test('the back-off halves down to the floor of 10 and stays there, retrying each page at most once', async () => {
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 50 }, ctoContext, async (args) => {
    calls.push(args);
    // The first attempt at every page times out; its retry succeeds.
    if (calls.length % 2 === 1) throw pageTimeout();
    return inWindowPage(args.limit, calls.length < 8 ? `c${calls.length}` : null);
  });

  assert.deepEqual(calls.map((c) => c.limit), [50, 25, 25, 12, 12, 10, 10, 10]);
  assert.deepEqual(calls.map((c) => c.cursor), [undefined, undefined, 'c2', 'c2', 'c4', 'c4', 'c6', 'c6']);
  assert.ok(calls.slice(1).every((c) => c.limit >= N8N_EXECUTION_LIST_MIN_PAGE_SIZE));
  assert.equal(result.observed_count, 25 + 12 + 10 + 10);
  assert.equal(result.truncated, false);
  assert.equal(result.effective_page_size, N8N_EXECUTION_LIST_MIN_PAGE_SIZE);
  assert.equal(result.page_timeout_retries, 4);
});

test('nextPageSizeAfterTimeout halves, never goes below the floor, and never grows a small caller limit', () => {
  assert.deepEqual([50, 25, 12, 11, 10].map(nextPageSizeAfterTimeout), [25, 12, 10, 10, 10]);
  assert.deepEqual([9, 5, 1].map(nextPageSizeAfterTimeout), [9, 5, 1]);
});

test('when the retry also times out, the counts gathered so far come back with truncated=true and reason page_timeout', async () => {
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext, async (args) => {
    calls.push(args);
    if (calls.length === 1) return inWindowPage(50, 'c1');
    throw pageTimeout();
  });

  // Page 2 is tried at 50, retried once at 25, then given up on: no further requests.
  assert.deepEqual(calls.map((c) => c.limit), [50, 50, 25]);
  assert.deepEqual(result, {
    observed_count: 50,
    counts_by_status: { ...freshCounts(), success: 50 },
    truncated: true,
    scanned_count: 50,
    truncated_reason: 'page_timeout',
    effective_page_size: 25,
    page_timeout_retries: 1,
  });
});

test('with nothing gathered yet, a page that keeps timing out fails with a fixed safe error instead of returning zeros', async () => {
  const calls: ListExecutionsArgs[] = [];
  await assert.rejects(
    getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext, async (args) => {
      calls.push(args);
      throw pageTimeout();
    }),
    (error: Error) => error.message === 'n8n_execution_list_page_timeout' && !error.message.includes('SYNTHETIC'),
  );
  assert.deepEqual(calls.map((c) => c.limit), [50, 25]);
});

test('budget exhaustion between pages returns the pages gathered so far with truncated=true and reason time_budget', async () => {
  let clock = 1_000_000;
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary(
    { ...validInput, limit: 50 },
    ctoContext,
    async (args) => {
      calls.push(args);
      clock += 12_000; // each page takes 12 s, so the second one crosses the 20 s budget
      return inWindowPage(50, `c${calls.length}`, calls.length === 1 ? 'success' : 'error');
    },
    () => clock,
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(result, {
    observed_count: 100,
    counts_by_status: { ...freshCounts(), success: 50, error: 50 },
    truncated: true,
    scanned_count: 100,
    truncated_reason: 'time_budget',
  });
});

test('a timed-out page that used up the time budget returns the partial counts with reason time_budget and is not retried', async () => {
  let clock = 5_000_000;
  const calls: ListExecutionsArgs[] = [];
  const result = await getN8nExecutionCountSummary(
    { ...validInput, limit: 50 },
    ctoContext,
    async (args) => {
      calls.push(args);
      if (calls.length === 1) return inWindowPage(50, 'c1');
      clock += N8N_EXECUTION_LIST_SCAN_BUDGET_MS; // the stalled page used up what was left of the budget
      throw pageTimeout();
    },
    () => clock,
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(result, {
    observed_count: 50,
    counts_by_status: { ...freshCounts(), success: 50 },
    truncated: true,
    scanned_count: 50,
    truncated_reason: 'time_budget',
  });
});

test('hitting the page cap reports truncated=true with reason page_cap', async () => {
  let calls = 0;
  const result = await getN8nExecutionCountSummary({ ...validInput, limit: 1 }, ctoContext, async () => {
    calls += 1;
    return { data: [exec('success', '2026-09-01T10:00:00.000Z')], nextCursor: `c${calls}` };
  });
  assert.equal(result.truncated, true);
  assert.equal(result.truncated_reason, 'page_cap');
});

test('only a page timeout is retried: any other upstream error still fails closed at once, even after a partial scan', async () => {
  let calls = 0;
  await assert.rejects(
    getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext, async () => {
      calls += 1;
      if (calls === 1) return inWindowPage(50, 'c1');
      throw new N8nFullError({ code: 'n8n_upstream_error', status: 502, message: 'SYNTHETIC_UPSTREAM_BODY', nextStep: 'synthetic' });
    }),
    (error: Error) => error.message === 'n8n_execution_list_request_failed' && !error.message.includes('SYNTHETIC'),
  );
  assert.equal(calls, 2);
});

test('an upstream page larger than the capped page size fails closed', async () => {
  await assert.rejects(
    getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext, async () => inWindowPage(N8N_EXECUTION_LIST_MAX_PAGE_SIZE + 1, null)),
    { message: 'n8n_execution_list_invalid_response' },
  );
});

test('the upstream query never asks n8n for more than the capped page size', () => {
  assert.deepEqual(buildListExecutionsQuery({ ...apiArgs, limit: 100 }), { limit: 50, includeData: false });
  assert.deepEqual(buildListExecutionsQuery({ ...apiArgs, limit: 50 }), { limit: 50, includeData: false });
  assert.deepEqual(buildListExecutionsQuery({ ...apiArgs, limit: 49 }), { limit: 49, includeData: false });
  assert.deepEqual(buildListExecutionsQuery({ ...apiArgs, limit: 1 }), { limit: 1, includeData: false });
});

test('n8n takes the page size from its cursor, so the requested size is stamped into the cursor that is sent', () => {
  const cursor = encodeCursor({ lastId: '4711', limit: 50 });
  const smaller = buildListExecutionsQuery({ ...apiArgs, limit: 25, cursor });
  assert.equal(smaller.limit, 25);
  assert.deepEqual(decodeCursor(String(smaller.cursor)), { lastId: '4711', limit: 25 });

  // A cursor already at the requested size is passed through byte for byte.
  assert.equal(buildListExecutionsQuery({ ...apiArgs, limit: 50, cursor }).cursor, cursor);

  // A limit above the cap is clamped first, so the stamped cursor can never exceed the cap either.
  const clamped = buildListExecutionsQuery({ ...apiArgs, limit: 100, cursor: encodeCursor({ lastId: '4711', limit: 100 }) });
  assert.equal(clamped.limit, 50);
  assert.deepEqual(decodeCursor(String(clamped.cursor)), { lastId: '4711', limit: 50 });

  // Other fields and their order are kept, whichever pagination shape n8n uses.
  assert.equal(withCursorLimit(encodeCursor({ limit: 1, offset: 1 }), 3), encodeCursor({ limit: 3, offset: 1 }));

  // A cursor in a shape we do not recognise is passed through unchanged.
  for (const odd of [
    'SYNTHETIC_CURSOR_TOKEN',
    encodeCursor([50]),
    encodeCursor('50'),
    encodeCursor({ lastId: '1' }),
    encodeCursor({ lastId: '1', limit: 'fifty' }),
    encodeCursor({ lastId: '1', limit: 2.5 }),
  ]) {
    assert.equal(withCursorLimit(odd, 25), odd);
  }
});

// ── Same behaviour end to end through the real client, with global fetch mocked ─────────────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Run `run` with global fetch replaced. GET /healthz (the reachability probe) always answers 200. */
async function withMockedN8nFetch<T>(
  answer: (url: URL, init: RequestInit | undefined, requestNumber: number) => Response | Promise<Response>,
  run: (requests: URL[]) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/healthz') return new Response('ok', { status: 200 });
    requests.push(url);
    return answer(url, init, requests.length);
  }) as typeof fetch;
  __resetN8nReachabilityCache();
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = realFetch;
    __resetN8nReachabilityCache();
  }
}

test('limit 100 reaches n8n as two requests of 50 and is assembled into one summary (mocked fetch)', async () => {
  const page1 = inWindowPage(50, encodeCursor({ lastId: '51', limit: 50 }));
  const page2 = inWindowPage(50, null, 'error');
  await withMockedN8nFetch(
    (_url, _init, n) => json(n === 1 ? page1 : page2),
    async (requests) => {
      const result = await getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext);

      assert.deepEqual(requests.map((u) => u.searchParams.get('limit')), ['50', '50']);
      assert.deepEqual(requests.map((u) => u.searchParams.get('cursor')), [null, page1.nextCursor]);
      for (const url of requests) {
        assert.equal(url.pathname, '/api/v1/executions');
        assert.equal(url.searchParams.get('includeData'), 'false');
        for (const key of url.searchParams.keys()) {
          assert.ok(N8N_SUPPORTED_EXECUTION_QUERY_PARAMS.includes(key), `unsupported n8n query parameter: ${key}`);
        }
      }
      assert.deepEqual(result, {
        observed_count: 100,
        counts_by_status: { ...freshCounts(), success: 50, error: 50 },
        truncated: false,
        scanned_count: 100,
        effective_page_size: 50,
      });
    },
  );
});

test('a timed-out page is re-requested at half the size with that size stamped into its cursor (mocked fetch)', async () => {
  const firstCursor = encodeCursor({ lastId: '51', limit: 50 });
  await withMockedN8nFetch(
    (url) => {
      if (url.searchParams.get('cursor') === null) return json(inWindowPage(50, firstCursor));
      // n8n is too slow for a page of 50 but copes with 25.
      if (url.searchParams.get('limit') === '50') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return json(inWindowPage(25, null));
    },
    async (requests) => {
      const result = await getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext);

      const last = requests[requests.length - 1];
      assert.equal(last.searchParams.get('limit'), '25');
      assert.deepEqual(decodeCursor(String(last.searchParams.get('cursor'))), { lastId: '51', limit: 25 });
      assert.deepEqual(result, {
        observed_count: 75,
        counts_by_status: { ...freshCounts(), success: 75 },
        truncated: false,
        scanned_count: 75,
        effective_page_size: 25,
        page_timeout_retries: 1,
      });
    },
  );
});

test('a hung n8n page is cut off by its deadline and reported as the typed page timeout, not repeated at the same size (mocked fetch)', async () => {
  await withMockedN8nFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    async (requests) => {
      // AbortSignal.timeout() timers are unref'd, so without this the test process would exit while it waits.
      const keepAlive = setTimeout(() => undefined, 10_000);
      try {
        const started = Date.now();
        await assert.rejects(
          listExecutions({ ...apiArgs, limit: 50 }, { deadlineAtMs: Date.now() + 100 }),
          (error: unknown) =>
            isN8nExecutionPageTimeout(error) &&
            error instanceof N8nFullError &&
            error.code === N8N_EXECUTION_PAGE_TIMEOUT_CODE &&
            error.message === 'n8n did not return a page of 50 executions in time.',
        );
        assert.equal(requests.length, 1);
        assert.ok(Date.now() - started < 3_000);
      } finally {
        clearTimeout(keepAlive);
      }
    },
  );
});

test('a fast 502 is still retried once inside the page window (mocked fetch)', async () => {
  const page = { data: [], nextCursor: null };
  await withMockedN8nFetch(
    (_url, _init, n) => (n === 1 ? new Response('bad gateway', { status: 502, headers: { 'retry-after': '0' } }) : json(page)),
    async (requests) => {
      assert.deepEqual(await listExecutions({ ...apiArgs, limit: 50 }), page);
      assert.equal(requests.length, 2);
    },
  );
});

test('only a timeout is typed as a page timeout: a 5xx that survives its retry stays an ordinary upstream error (mocked fetch)', async () => {
  await withMockedN8nFetch(
    () => new Response('bad gateway', { status: 502, headers: { 'retry-after': '0' } }),
    async () => {
      await assert.rejects(
        listExecutions({ ...apiArgs, limit: 50 }),
        (error: unknown) => error instanceof N8nFullError && error.code === 'n8n_upstream_error' && !isN8nExecutionPageTimeout(error),
      );
    },
  );
});

/** What node's fetch rejects with when a connection is reset or refused: a TypeError, not an abort. */
function connectionReset(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
}

test('only a timeout is typed as a page timeout: a reset connection stays an ordinary network error (mocked fetch)', async () => {
  await withMockedN8nFetch(
    () => {
      throw connectionReset();
    },
    async (requests) => {
      await assert.rejects(
        listExecutions({ ...apiArgs, limit: 50 }),
        (error: unknown) => error instanceof N8nFullError && error.code === 'n8n_network_error' && !isN8nExecutionPageTimeout(error),
      );
      // Like a 5xx, a network error is retried once inside the page window.
      assert.equal(requests.length, 2);
    },
  );
});

test('a connection failure that is not a timeout fails the scan closed even after a page was gathered, without a half-size retry (mocked fetch)', async () => {
  await withMockedN8nFetch(
    (url) => {
      if (url.searchParams.get('cursor') === null) return json(inWindowPage(50, encodeCursor({ lastId: '51', limit: 50 })));
      throw connectionReset();
    },
    async (requests) => {
      await assert.rejects(
        getN8nExecutionCountSummary({ ...validInput, limit: 100 }, ctoContext),
        (error: unknown) => error instanceof Error && error.message === 'n8n_execution_list_request_failed',
      );
      assert.ok(requests.length >= 2);
      assert.ok(
        requests.every((url) => url.searchParams.get('limit') === '50'),
        'a failure that is not a timeout must not shrink the page',
      );
    },
  );
});
