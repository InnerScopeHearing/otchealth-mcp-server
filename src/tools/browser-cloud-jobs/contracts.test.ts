import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { BrowserJobError, CloudBrowserJobs, type BrowserJob, type CloudBrowserJobStore } from './contracts.js';
import { CloudBrowserJobWorker } from './worker.js';

const sha = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
function harness() {
  let now = Date.parse('2026-09-20T00:00:00.000Z'); let counter = 0; const jobs = new Map<string, { job: BrowserJob; version: string }>(); const queued: string[] = [];
  const store: CloudBrowserJobStore = {
    async createIfAbsent(job) { if ([...jobs.values()].some(x => x.job.agent === job.agent && x.job.idempotencyDigest === job.idempotencyDigest)) return 'exists'; jobs.set(job.id, { job: structuredClone(job), version: '1' }); return 'created'; },
    async readById(id) { const hit = jobs.get(id); return hit && { value: structuredClone(hit.job), version: hit.version }; },
    async readByIdempotency(agent, key) { const hit = [...jobs.values()].find(x => x.job.agent === agent && x.job.idempotencyDigest === key); return hit && { value: structuredClone(hit.job), version: hit.version }; },
    async replace(job, expected) { const prior = jobs.get(job.id); if (!prior || prior.version !== expected) return 'conflict'; jobs.set(job.id, { job: structuredClone(job), version: String(Number(expected) + 1) }); return 'replaced'; },
  };
  const api = new CloudBrowserJobs(store, { enqueue: async id => { queued.push(id); } }, { putImmutable: async () => ({ version: 'v1' }), getVersion: async () => ({ body: Buffer.alloc(0), contentType: 'application/json' }) }, () => now, () => String(++counter));
  return { api, queued, tick: (ms: number) => { now += ms; } };
}

test('safe pre-effect failures cannot consume browser attempts indefinitely', async () => {
  const h = harness();
  const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'bounded:attempts', request: {} });
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await h.api.claim(job.id, 'cto', 1_000)).attempts, attempt);
    h.tick(1_001);
  }
  await assert.rejects(h.api.claim(job.id, 'cto', 1_000), /job_terminal/);
  const exhausted = await h.api.get(job.id, 'cto');
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.errorCode, 'retry_limit_reached');
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.leaseOwner, null);
  await assert.rejects(h.api.claim(job.id, 'cfo', 1_000), /job_owner_mismatch/);
});

test('an uncertain final attempt remains reconciliation work, never a safe failed retry', async () => {
  const h = harness();
  const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'bounded:uncertain', request: {} });
  for (let attempt = 1; attempt <= 2; attempt++) { await h.api.claim(job.id, 'cto', 1_000); h.tick(1_001); }
  const run = await h.api.claim(job.id, 'cto', 1_000);
  await h.api.beginExternalEffect(job.id, 'cto', run.leaseToken, 'navigate:final');
  h.tick(1_001);
  await assert.rejects(h.api.claim(job.id, 'cto', 1_000), /effect_reconciliation_required/);
  assert.equal((await h.api.get(job.id, 'cto')).status, 'needs_reconciliation');
});

test('a completed final action is not discarded as a safe exhausted retry', async () => {
  const h = harness();
  const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'bounded:succeeded', request: {} });
  for (let attempt = 1; attempt <= 2; attempt++) { await h.api.claim(job.id, 'cto', 1_000); h.tick(1_001); }
  const run = await h.api.claim(job.id, 'cto', 1_000);
  await h.api.beginExternalEffect(job.id, 'cto', run.leaseToken, 'navigate:final');
  await h.api.recordExternalEffectSucceeded(job.id, 'cto', run.leaseToken, 'navigate:final');
  h.tick(1_001);
  await assert.rejects(h.api.claim(job.id, 'cto', 1_000), /effect_reconciliation_required/);
  assert.equal((await h.api.get(job.id, 'cto')).status, 'needs_reconciliation');
});

test('worker acknowledges an exhausted safe job without a fourth provider execution', async () => {
  const h = harness();
  const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'bounded:worker', request: {} });
  let executions = 0; let deletions = 0;
  const queue = { enqueue: async () => undefined, receive: async () => [{ id: 'm', receipt: 'r', jobId: job.id, agent: 'cto' }], changeVisibility: async () => undefined, delete: async () => { deletions++; } };
  const worker = new CloudBrowserJobWorker(h.api, queue, { execute: async () => { executions++; throw new Error('synthetic pre-effect failure'); } }, 1_000);
  for (let attempt = 1; attempt <= 3; attempt++) { await worker.pollOnce(); h.tick(1_001); }
  await worker.pollOnce();
  assert.equal(executions, 3);
  assert.equal(deletions, 1);
  assert.equal((await h.api.get(job.id, 'cto')).status, 'failed');
});

test('worker retains pre-effect expired delivery and persists uncertain outcome before deletion', async () => {
  for (const effect of [false, true]) {
    const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'worker:expiry', request: {} });
    let deleted = false;
    const queue = { enqueue: async () => undefined, receive: async () => [{ id: 'm', receipt: 'r', jobId: job.id, agent: 'cto' }], changeVisibility: async () => undefined,
      delete: async () => { assert.equal((await h.api.get(job.id, 'cto')).status, 'needs_reconciliation'); deleted = true; } };
    const worker = new CloudBrowserJobWorker(h.api, queue, { execute: async (_run, control) => {
      if (effect) await control.beginExternalEffect('click:1');
      h.tick(1_001); await control.heartbeat();
    } }, 1_000);
    const receipt = await worker.pollOnce();
    assert.equal(deleted, effect);
    assert.equal(receipt.heldForRetry, effect ? 0 : 1);
    if (!effect) assert.equal((await h.api.claim(job.id, 'cto', 1_000)).attempts, 2);
    else await assert.rejects(h.api.claim(job.id, 'cto', 1_000), /job_terminal/);
  }
});

test('reconciliation cannot overwrite a newer worker lease', async () => {
  const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'worker:fence', request: {} });
  const old = await h.api.claim(job.id, 'cto', 1_000); h.tick(1_001);
  const current = await h.api.claim(job.id, 'cto', 1_000);
  await assert.rejects(h.api.markNeedsReconciliation(job.id, 'cto', old.leaseToken, 'expired'), /stale_lease/);
  assert.equal((await h.api.get(job.id, 'cto')).leaseToken, current.leaseToken);
});

test('submission is idempotent only for the same agent and canonical request', async () => {
  const h = harness(); const a = await h.api.submit({ agent: 'cto', idempotencyKey: 'submit:001', request: { b: 2, a: 1 } }); const b = await h.api.submit({ agent: 'cto', idempotencyKey: 'submit:001', request: { a: 1, b: 2 } });
  assert.equal(b.replayed, true); assert.equal(a.job.id, b.job.id); assert.deepEqual(h.queued, [a.job.id]);
  await assert.rejects(h.api.submit({ agent: 'cto', idempotencyKey: 'submit:001', request: { a: 9 } }), (e: unknown) => e instanceof BrowserJobError && e.code === 'idempotency_conflict');
});
test('lease fencing rejects zombies and cross-agent access', async () => {
  const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'lease:001', request: {} }); const first = await h.api.claim(job.id, 'cto', 1_000); h.tick(1_001); const second = await h.api.claim(job.id, 'cto', 1_000);
  await assert.rejects(h.api.complete(job.id, 'cto', first.leaseToken), /stale_lease/); await assert.rejects(h.api.heartbeat(job.id, 'cfo', second.leaseToken, 1_000), /job_owner_mismatch/);
});
test('uncertain external effects require reconciliation and are never automatically retried', async () => {
  const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'effect:001', request: {} }); const run = await h.api.claim(job.id, 'cto', 1_000); await h.api.beginExternalEffect(job.id, 'cto', run.leaseToken);
  h.tick(1_001); await assert.rejects(h.api.complete(job.id, 'cto', run.leaseToken), /lease_expired/); await assert.rejects(h.api.claim(job.id, 'cto', 1_000), /effect_reconciliation_required/);
  const reconciled = await h.api.reconcileExternalEffect(job.id, 'cto', 'not_started'); assert.equal(reconciled.status, 'queued');
});
test('heartbeat reloads cancellation written after a claim', async () => {
  const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'cancel:001', request: {} }); const run = await h.api.claim(job.id, 'cto', 1_000);
  await h.api.requestCancellation(job.id, 'cto'); const current = await h.api.heartbeat(job.id, 'cto', run.leaseToken, 1_000);
  assert.notEqual(current.cancellationRequestedAt, null); assert.equal(current.status, 'cancelling');
});
test('artifact metadata is agent/job scoped and completed jobs require a current lease', async () => {
  const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'artifact:001', request: {} }); const run = await h.api.claim(job.id, 'cto', 1_000); const body = Buffer.from('synthetic receipt'); const artifact = await h.api.attachArtifact(job.id, 'cto', run.leaseToken, body, 'text/plain', sha(body));
  assert.match(artifact.storageKey, new RegExp(`^browser-cloud/cto/${job.id}/artifacts/`)); assert.equal((await h.api.complete(job.id, 'cto', run.leaseToken)).status, 'succeeded');
});
test('binary artifacts hash their exact bytes', async () => {
  const h = harness(); const { job } = await h.api.submit({ agent: 'cto', idempotencyKey: 'binary:001', request: {} }); const run = await h.api.claim(job.id, 'cto', 1_000); const body = Buffer.from([0, 255, 128, 10]);
  await assert.doesNotReject(h.api.attachArtifact(job.id, 'cto', run.leaseToken, body, 'application/octet-stream', sha(body)));
});
