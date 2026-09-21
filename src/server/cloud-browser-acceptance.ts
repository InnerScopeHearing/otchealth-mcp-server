import { randomUUID } from 'node:crypto';
import { cloudBrowserRuntime } from './cloud-browser-runtime.js';
import { startCloudBrowserWorker } from '../tools/browser-cloud-gateway/index.js';

/** One-off ECS candidate test. Public fixtures only; never logs browser content or credentials. */
async function main(): Promise<void> {
  const runtime = cloudBrowserRuntime;
  const started = await runtime.browser.start('cto', 'cto-public-trial', 120);
  try {
    let denied = false;
    try { await runtime.browser.snapshot('cfo', started.sessionId); } catch { denied = true; }
    if (!denied) throw new Error('cross_owner_access_not_denied');
    await runtime.browser.execute('cto', started.sessionId, { type: 'navigate', url: 'https://example.com/' }, 20);
    await runtime.browser.execute('cto', started.sessionId, { type: 'wait_for', selector: 'h1' }, 20);
    const observed = await runtime.browser.snapshot('cto', started.sessionId) as { title?: string; visibleText?: string };
    if (!observed.title?.includes('Example Domain') || !observed.visibleText?.includes('Example Domain')) throw new Error('public_page_observation_failed');
    await runtime.browser.savePersistentProfile('cto', started.sessionId);
    console.log(JSON.stringify({ check: 'session', navigation: true, observation: true, crossOwnerDenied: true, profileSaved: true }));
  } finally { await runtime.browser.stop('cto', started.sessionId); }
  const idempotencyKey = `acceptance:${randomUUID()}`;
  const request = { profile_id: 'cto-public-trial', max_seconds: 120, actions: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'wait_for', selector: 'h1' }] };
  const created = await runtime.jobs.submit({ agent: 'cto', idempotencyKey, request });
  const replay = await runtime.jobs.submit({ agent: 'cto', idempotencyKey, request });
  if (!replay.replayed || replay.job.id !== created.job.id) throw new Error('idempotency_failed');
  const worker = startCloudBrowserWorker(runtime);
  if (!worker) throw new Error('worker_not_configured');
  await worker.pollOnce(1);
  const result = await runtime.jobs.get(created.job.id, 'cto');
  if (result.status !== 'succeeded' || result.artifacts.length < 1) throw new Error(`durable_job_failed:${result.status}:${result.errorCode}`);
  console.log(JSON.stringify({ check: 'durable_job', jobId: result.id, status: result.status, idempotency: true, artifacts: result.artifacts.length }));
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'unknown_failure';
  console.error(JSON.stringify({ acceptance: 'failed', code: code.slice(0, 160) }));
  process.exitCode = 1;
});
