import assert from 'node:assert/strict';
import test from 'node:test';
process.env.CIO_SITE_ID ??= 'test'; process.env.CIO_TRACK_KEY ??= 'test'; process.env.CIO_APP_API_BEARER ??= 'test'; process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 'p'.repeat(32); process.env.ADMIN_REVOKE_TOKEN ??= 'a'.repeat(32); process.env.N8N_WEBHOOK_SECRET ??= 'n'.repeat(32);

test('chat action jobs are caller-bound and idempotent', async () => {
  const { createChatActionJob } = await import('./chat-action-jobs.js');
  const docs = new Map<string, any>(); const deps = { configured: () => true, readDoc: async (_c: string, _p: string, id: string) => docs.get(id) ?? null, createDoc: async (_c: string, _p: string, doc: any) => { docs.set(doc.id, doc); return doc; } };
  const input = { action: 'brain_search' as const, request: { query: 'synthetic company status' }, idempotency_key: 'chat-job-test-01', correlation_id: 'corr-1', caller_hash: 'caller-a-123456', caller_agent: 'coo' };
  const first = await createChatActionJob(input, deps); const replay = await createChatActionJob(input, deps);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(first.job.id, replay.job.id); assert.equal(first.job.status, 'queued');
});

test('personal legal actions are rejected before persistence', async () => {
  const { createChatActionJob } = await import('./chat-action-jobs.js');
  const deps = { configured: () => true, readDoc: async () => null, createDoc: async () => { throw new Error('must not write'); } };
  await assert.rejects(() => createChatActionJob({ action: 'checkpoint', request: { agent: 'clo-personal' }, idempotency_key: 'chat-job-test-02', correlation_id: 'corr-2', caller_hash: 'caller-a-123456', caller_agent: 'clo-personal' }, deps), /clo-personal/);
});

test('chat action status reads coalesce per caller, return only status, and do not cache completed reads', async () => {
  const { createChatActionJobStatusReader } = await import('./chat-action-jobs.js');
  const jobId = `caj_${'1'.repeat(64)}`;
  const job = { id: jobId, type: 'chat_action_job', caller_hash: 'caller-a-123456', action: 'brain_search', request: { query: 'synthetic fixture' }, idempotency_key_hash: 'synthetic', status: 'running', result: { answer: 'synthetic fixture' }, created_at: '', updated_at: '' };
  let readCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readStatus = createChatActionJobStatusReader(async (_collection, _partitionKey, id) => {
    readCalls++;
    assert.equal(id, jobId);
    await gate;
    return job;
  });

  const first = readStatus(jobId, 'caller-a-123456');
  const duplicate = readStatus(jobId, 'caller-a-123456');
  const otherCaller = readStatus(jobId, 'caller-b-123456');
  await Promise.resolve();
  assert.equal(readCalls, 2, 'same caller shares one read, while another caller performs an isolated read');

  release();
  const [one, two, foreign] = await Promise.all([first, duplicate, otherCaller]);
  assert.deepEqual(one, { job_id: jobId, status: 'running' });
  assert.deepEqual(two, one);
  assert.equal(foreign, null, 'a different caller cannot reuse another caller\'s status result');

  assert.deepEqual(await readStatus(jobId, 'caller-a-123456'), one);
  assert.equal(readCalls, 3, 'a completed status read is removed and fetched again on the next request');
});

test('chat action status read failures clear the in-flight entry so a later call can retry', async () => {
  const { createChatActionJobStatusReader } = await import('./chat-action-jobs.js');
  const jobId = `caj_${'2'.repeat(64)}`;
  const job = { id: jobId, type: 'chat_action_job', caller_hash: 'caller-a-123456', action: 'brain_search', request: {}, idempotency_key_hash: 'synthetic', status: 'queued', created_at: '', updated_at: '' };
  let readCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readStatus = createChatActionJobStatusReader(async () => {
    readCalls++;
    if (readCalls === 1) {
      await gate;
      throw new Error('synthetic read failure');
    }
    return job;
  });

  const first = readStatus(jobId, 'caller-a-123456');
  const duplicate = readStatus(jobId, 'caller-a-123456');
  await Promise.resolve();
  assert.equal(readCalls, 1, 'concurrent retries share the pending failure');
  release();
  await assert.rejects(Promise.all([first, duplicate]), /synthetic read failure/);

  assert.deepEqual(await readStatus(jobId, 'caller-a-123456'), { job_id: jobId, status: 'queued' });
  assert.equal(readCalls, 2, 'the rejected entry was removed before the retry');
});

test('chat action status coalescer never stores more than its fixed in-flight bound', async () => {
  const { createChatActionJobStatusReader, MAX_IN_FLIGHT_CHAT_ACTION_STATUS_READS } = await import('./chat-action-jobs.js');
  let readCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const readStatus = createChatActionJobStatusReader(async (_collection, _partitionKey, id) => {
    readCalls++;
    await gate;
    return { id, type: 'chat_action_job', caller_hash: 'caller-a-123456', status: 'queued' };
  });
  const pending = Array.from({ length: MAX_IN_FLIGHT_CHAT_ACTION_STATUS_READS }, (_, index) =>
    readStatus(`caj_${index.toString(16).padStart(64, '0')}`, 'caller-a-123456'),
  );
  await Promise.resolve();
  assert.equal(readCalls, MAX_IN_FLIGHT_CHAT_ACTION_STATUS_READS);

  const overflowJobId = `caj_${MAX_IN_FLIGHT_CHAT_ACTION_STATUS_READS.toString(16).padStart(64, '0')}`;
  const overflowOne = readStatus(overflowJobId, 'caller-a-123456');
  const overflowTwo = readStatus(overflowJobId, 'caller-a-123456');
  await Promise.resolve();
  assert.equal(readCalls, MAX_IN_FLIGHT_CHAT_ACTION_STATUS_READS + 2, 'overflow reads bypass the map instead of growing it');

  release();
  await Promise.all([...pending, overflowOne, overflowTwo]);
});
