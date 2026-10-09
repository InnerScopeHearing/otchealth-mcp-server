import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
// full-client validates the process environment at import time. Synthetic placeholders only, plus a
// throwaway RSA key so the GitHub App JWT can be signed without any real credential.
process.env.CIO_SITE_ID ??= 'synthetic';
process.env.CIO_TRACK_KEY ??= 'synthetic';
process.env.CIO_APP_API_BEARER ??= 'synthetic';
process.env.PERPLEXITY_CONNECTOR_TOKEN ??= 's'.repeat(32);
process.env.ADMIN_REVOKE_TOKEN ??= 's'.repeat(32);
process.env.N8N_WEBHOOK_SECRET ??= 's'.repeat(32);
process.env.GITHUB_APP_ID = '123456';
process.env.GITHUB_APP_INSTALLATION_ID = '789';
process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const { CI_LOG_MAX_EXCERPT_BYTES, CI_LOG_MAX_FAILED_JOBS, CI_LOG_MAX_FAILED_STEPS_PER_JOB, CI_LOG_REDACTED } =
  await import('../../github/ci-log-excerpt.js');
const { workflowJobLogTail } = await import('../../github/full-client.js');
const { getFailedCiLogExcerpt } = await import('./workflow-run-failed-log-excerpt.js');
type Deps = Parameters<typeof getFailedCiLogExcerpt>[2] & object;

const GH_TOKEN = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
const cto = { callerAgent: 'cto' };
const LOG = [
  '2026-10-06T21:00:00.1000000Z ##[group]Run actions/checkout@v4',
  '2026-10-06T21:00:01.2000000Z checkout done',
  '2026-10-06T21:00:05.0000000Z ##[group]Run npm test',
  '2026-10-06T21:00:06.5000000Z FAIL src/foo.test.ts',
  `2026-10-06T21:00:06.6000000Z   GH_TOKEN: ${GH_TOKEN}`,
  '2026-10-06T21:00:07.4000000Z ##[error]Process completed with exit code 1.',
  '2026-10-06T21:00:08.0000000Z Post job cleanup.',
].join('\n');
const step = (number: number, name: string, conclusion: string, from: string, to: string) =>
  ({ number, name, conclusion, started_at: `2026-10-06T${from}.000Z`, completed_at: `2026-10-06T${to}.000Z` });
const goodSteps = () => [
  step(1, 'Checkout', 'success', '21:00:00', '21:00:04'),
  step(2, 'Run tests', 'failure', '21:00:05', '21:00:07'),
  step(3, 'Post job', 'success', '21:00:08', '21:00:08'),
];
const job = (id: number, conclusion: string, steps: unknown[] = goodSteps()) =>
  ({ id, name: `job-${id}`, conclusion, html_url: `https://github.com/o/r/actions/runs/1/job/${id}`, steps });

function makeDeps(jobs: any[], logFor: (jobId: number) => any = () => ({ status: 'ok', text: LOG, headTruncated: false })) {
  const calls = { listJobs: 0, getJob: 0, fetchLog: [] as number[] };
  const deps: Deps = {
    listJobs: async () => { calls.listJobs += 1; return jobs; },
    getJob: async (_o: string, _r: string, id: number) => { calls.getJob += 1; return jobs.find((j) => j.id === id); },
    fetchLog: async (_o: string, _r: string, id: number) => { calls.fetchLog.push(id); return logFor(id); },
  };
  return { deps, calls };
}

test('only the CTO lane may call it, and bad input is refused before any upstream call', async () => {
  const { deps, calls } = makeDeps([job(1, 'failure')]);
  for (const caller of ['developer', 'cfo', 'clo', 'coo', 'cro', 'exec', '']) {
    await assert.rejects(getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 1 }, { callerAgent: caller }, deps), { message: 'github_failed_log_excerpt_forbidden' }, caller);
  }
  for (const bad of [
    { owner: 'o', repo: 'r' },
    { owner: 'o', repo: 'r', run_id: 1, job_id: 2 },
    { owner: 'o/x', repo: 'r', run_id: 1 },
    { owner: 'o', repo: '../r', run_id: 1 },
    { owner: 'o', repo: 'r', run_id: 0 },
    { owner: 'o', repo: 'r', run_id: 1.5 },
    { owner: 'o', repo: 'r', run_id: 1, extra: true },
  ]) {
    await assert.rejects(getFailedCiLogExcerpt(bad, cto, deps), { message: 'github_failed_log_excerpt_invalid_input' }, JSON.stringify(bad));
  }
  for (const repo of ['medreview-app', 'MedReview', 'phi-service', 'my-phi']) {
    await assert.rejects(getFailedCiLogExcerpt({ owner: 'o', repo, run_id: 1 }, cto, deps), { message: 'github_failed_log_excerpt_phi_repo_blocked' }, repo);
  }
  assert.deepEqual(calls, { listJobs: 0, getJob: 0, fetchLog: [] });
});

test('run mode fetches logs for FAILED jobs only and returns the redacted tail of the failed step', async () => {
  const { deps, calls } = makeDeps([job(11, 'success'), job(12, 'failure'), job(13, 'cancelled'), job(14, 'skipped')]);
  const result = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 99 }, cto, deps);
  assert.deepEqual(calls.fetchLog, [12]);
  assert.equal(result.repository, 'o/r');
  assert.equal(result.jobs_total, 4);
  assert.equal(result.jobs_failed, 1);
  assert.equal(result.jobs_omitted, 0);
  const [only] = result.jobs;
  assert.equal(only?.job_id, 12);
  assert.equal(only?.log_status, 'ok');
  assert.equal(only?.html_url, 'https://github.com/o/r/actions/runs/1/job/12');
  assert.equal(only?.steps.length, 1);
  assert.equal(only?.steps[0]?.step_name, 'Run tests');
  assert.deepEqual(only?.steps[0]?.excerpt.split('\n'), [
    '##[group]Run npm test',
    'FAIL src/foo.test.ts',
    `  GH_TOKEN: ${CI_LOG_REDACTED}`,
    '##[error]Process completed with exit code 1.',
  ]);
  assert.ok(!JSON.stringify(result).includes(GH_TOKEN));
  assert.ok(result.notice.includes('Untrusted CI output'));
});

test('job mode: a passing job returns nothing and is never downloaded; a failed job is excerpted', async () => {
  const passing = makeDeps([job(5, 'success')]);
  const none = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', job_id: 5 }, cto, passing.deps);
  assert.equal(none.jobs_failed, 0);
  assert.deepEqual(none.jobs, []);
  assert.deepEqual(passing.calls.fetchLog, []);
  assert.equal(passing.calls.getJob, 1);

  const failing = makeDeps([job(6, 'timed_out', [step(1, 'Build', 'timed_out', '21:00:05', '21:00:07')])]);
  const some = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', job_id: 6 }, cto, failing.deps);
  assert.equal(some.jobs_failed, 1);
  assert.equal(some.jobs[0]?.conclusion, 'timed_out');
  assert.deepEqual(failing.calls.fetchLog, [6]);
});

test('job and step counts are capped and the omissions are reported', async () => {
  const many = Array.from({ length: CI_LOG_MAX_FAILED_JOBS + 2 }, (_, i) => job(100 + i, 'failure'));
  const { deps, calls } = makeDeps(many);
  const result = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 1 }, cto, deps);
  assert.equal(calls.fetchLog.length, CI_LOG_MAX_FAILED_JOBS);
  assert.equal(result.jobs_failed, CI_LOG_MAX_FAILED_JOBS + 2);
  assert.equal(result.jobs_omitted, 2);
  assert.equal(result.jobs.length, CI_LOG_MAX_FAILED_JOBS);

  const manySteps = Array.from({ length: CI_LOG_MAX_FAILED_STEPS_PER_JOB + 2 }, (_, i) => step(i + 1, `s${i}`, 'failure', '21:00:05', '21:00:07'));
  const stepped = makeDeps([job(7, 'failure', manySteps)]);
  const r2 = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 1 }, cto, stepped.deps);
  assert.equal(r2.jobs[0]?.steps.length, CI_LOG_MAX_FAILED_STEPS_PER_JOB);
  assert.equal(r2.jobs[0]?.failed_steps_omitted, 2);
});

test('a failed job with no failed step (setup failure) returns the job log tail once', async () => {
  const { deps } = makeDeps([job(8, 'failure', [step(1, 'Set up job', 'success', '21:00:00', '21:00:01')])]);
  const result = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 1 }, cto, deps);
  assert.equal(result.jobs[0]?.steps.length, 1);
  assert.equal(result.jobs[0]?.steps[0]?.attribution, 'job_tail');
  assert.ok(result.jobs[0]?.steps[0]?.excerpt.includes('Post job cleanup.'));
});

test('log download problems become fixed per-job statuses and never echo upstream text', async () => {
  const poison = 'SYNTHETIC_UPSTREAM_BODY_SECRET';
  const logs: Record<number, any> = {
    21: { status: 'unavailable' },
    22: { status: 'failed', reason: 'untrusted_redirect' },
  };
  const { deps } = makeDeps([job(21, 'failure'), job(22, 'failure'), job(23, 'failure')], (id) => {
    if (id === 23) throw new Error(poison);
    return logs[id];
  });
  const result = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 1 }, cto, deps);
  assert.deepEqual(result.jobs.map((j) => [j.job_id, j.log_status, j.log_failure_reason, j.steps.length]), [
    [21, 'unavailable', undefined, 0],
    [22, 'failed', 'untrusted_redirect', 0],
    [23, 'failed', 'request_error', 0],
  ]);
  assert.ok(!JSON.stringify(result).includes(poison));
});

test('worst case response: every failed step of every failed job stays under the size cap', async () => {
  const bigLog = Array.from({ length: 6_000 }, (_, i) => {
    const second = String(Math.floor(i / 100) % 60).padStart(2, '0');
    return `2026-10-06T21:00:${second}.${String(i % 100).padStart(2, '0')}0000Z ${'x'.repeat(380)} ${i}`;
  }).join('\n');
  const steps = Array.from({ length: CI_LOG_MAX_FAILED_STEPS_PER_JOB }, (_, i) => step(i + 1, `s${i}`, 'failure', '21:00:00', '21:00:59'));
  const jobs = Array.from({ length: CI_LOG_MAX_FAILED_JOBS }, (_, i) => job(200 + i, 'failure', steps));
  const { deps } = makeDeps(jobs, () => ({ status: 'ok', text: bigLog, headTruncated: true }));
  const result = await getFailedCiLogExcerpt({ owner: 'o', repo: 'r', run_id: 1 }, cto, deps);
  const excerptBytes = result.jobs.flatMap((j) => j.steps).reduce((n, s) => n + Buffer.byteLength(s.excerpt, 'utf8'), 0);
  assert.ok(excerptBytes > 0 && excerptBytes <= CI_LOG_MAX_EXCERPT_BYTES, `excerpt bytes ${excerptBytes}`);
  assert.ok(JSON.stringify(result).length < 40_000, `serialized ${JSON.stringify(result).length}`);
  assert.equal(result.jobs[0]?.log_head_truncated, true);
});

// ── workflowJobLogTail against a stubbed network ───────────────────────────────

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
const STORAGE = 'https://productionresultssa3.blob.core.windows.net/actions-results/abc/logs/job-logs.txt?sig=SYNTHETIC';

function stubNetwork(route: (url: string, init: any) => Response | Promise<Response>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input instanceof URL ? input.href : String(input);
    seen.push(url);
    if (url.endsWith('/access_tokens')) {
      return Response.json({ token: ['ghs', '_SYNTHETICINSTALLATIONTOKEN'].join(''), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return route(url, init ?? {});
  }) as typeof fetch;
  return seen;
}
const headerNames = (init: any) => Object.keys(init?.headers ?? {}).map((h) => h.toLowerCase());

test('log download follows the signed URL without sending the installation token to storage', async () => {
  const seen = stubNetwork((url, init) => {
    if (url === 'https://api.github.com/repos/o/r/actions/jobs/42/logs') {
      assert.equal(init.redirect, 'manual');
      assert.ok(String(init.headers.Authorization).startsWith('Bearer ghs_'));
      return new Response(null, { status: 302, headers: { location: STORAGE } });
    }
    assert.equal(url, STORAGE);
    assert.equal(init.redirect, 'error');
    assert.ok(!headerNames(init).includes('authorization'), 'token must not reach storage');
    return new Response(LOG);
  });
  const result = await workflowJobLogTail('o', 'r', 42);
  assert.deepEqual(result, { status: 'ok', text: LOG, headTruncated: false });
  assert.deepEqual(seen.filter((u) => !u.endsWith('/access_tokens')), ['https://api.github.com/repos/o/r/actions/jobs/42/logs', STORAGE]);
});

test('log download refuses an untrusted redirect target and never fetches it', async () => {
  for (const location of ['https://evil.example.com/logs.txt', 'http://productionresultssa3.blob.core.windows.net/actions-results/x', 'https://user:pw@pipelines.actions.githubusercontent.com/x', 'https://productionresultssa3.blob.core.windows.net/other-container/x']) {
    const seen = stubNetwork(() => new Response(null, { status: 302, headers: { location } }));
    assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'failed', reason: 'untrusted_redirect' }, location);
    assert.ok(!seen.includes(location));
  }
  stubNetwork(() => new Response(null, { status: 302 }));
  assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'failed', reason: 'untrusted_redirect' });
});

test('log download rejects a followed or misdirected signed download response without returning its body', async () => {
  for (const followed of [true, false]) {
    const seen = stubNetwork((url) => {
      if (url === 'https://api.github.com/repos/o/r/actions/jobs/42/logs') {
        return new Response(null, { status: 302, headers: { location: STORAGE } });
      }
      const response = new Response('SECRET_LOG_SHOULD_NOT_ESCAPE', { status: 200 });
      if (followed) Object.defineProperty(response, 'redirected', { value: true });
      else Object.defineProperty(response, 'url', { value: 'https://evil.example/final-log' });
      return response;
    });
    const result = await workflowJobLogTail('o', 'r', 42);
    assert.deepEqual(result, { status: 'failed', reason: 'untrusted_redirect' });
    assert.equal(JSON.stringify(result).includes('SECRET_LOG_SHOULD_NOT_ESCAPE'), false);
    assert.equal(seen.filter((url) => url === STORAGE).length, 1, 'the approved signed URL is fetched once without following another redirect');
  }
});

test('log download maps missing, expired and failing responses to fixed statuses', async () => {
  stubNetwork(() => new Response('{"message":"SYNTHETIC_UPSTREAM"}', { status: 404 }));
  assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'unavailable' });
  stubNetwork(() => new Response(null, { status: 403 }));
  assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'failed', reason: 'api_http_403' });
  stubNetwork((url) => (url.includes('/actions/jobs/') ? new Response(null, { status: 302, headers: { location: STORAGE } }) : new Response('gone', { status: 410 })));
  assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'unavailable' });
  stubNetwork((url) => (url.includes('/actions/jobs/') ? new Response(null, { status: 302, headers: { location: STORAGE } }) : new Response('nope', { status: 403 })));
  assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'failed', reason: 'download_http_403' });
  stubNetwork(() => { throw new Error('SYNTHETIC_NETWORK_FAILURE_DETAIL'); });
  assert.deepEqual(await workflowJobLogTail('o', 'r', 42), { status: 'failed', reason: 'request_error' });
});
