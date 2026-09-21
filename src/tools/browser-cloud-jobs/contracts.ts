import { createHash, randomUUID } from 'node:crypto';

export type BrowserJobStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'needs_reconciliation';
export type ExternalEffectState = 'none' | 'unknown' | 'not_started' | 'succeeded' | 'failed';

export interface BrowserJobRequest {
  agent: string;
  idempotencyKey: string;
  request: unknown;
}

export interface BrowserArtifactMetadata {
  id: string;
  jobId: string;
  agent: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  storageKey: string;
  storageVersion: string;
  createdAt: string;
}

export interface BrowserJob {
  id: string;
  agent: string;
  requestDigest: string;
  idempotencyDigest: string;
  /** Bounded, validated plan envelope. It is durable so a cloud worker never depends on the submitting Chat session. */
  request: unknown;
  status: BrowserJobStatus;
  createdAt: string;
  updatedAt: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  leaseToken: number;
  attempts: number;
  cancellationRequestedAt: string | null;
  externalEffect: ExternalEffectState;
  /** Per-action evidence state. A worker must mark a step unknown before each non-idempotent browser action. */
  actionEffects: Record<string, ExternalEffectState>;
  dispatchState: 'pending' | 'dispatched';
  dispatchAttempts: number;
  artifacts: BrowserArtifactMetadata[];
  errorCode: string | null;
}

export interface Versioned<T> { value: T; version: string; }
/** Implement with DynamoDB conditional PutItem/UpdateItem. This contract deliberately has no disk fallback. */
export interface CloudBrowserJobStore {
  createIfAbsent(job: BrowserJob): Promise<'created' | 'exists'>;
  readById(jobId: string): Promise<Versioned<BrowserJob> | null>;
  readByIdempotency(agent: string, idempotencyDigest: string): Promise<Versioned<BrowserJob> | null>;
  replace(job: BrowserJob, expectedVersion: string): Promise<'replaced' | 'conflict'>;
}
/** Implement with S3 versioning and If-None-Match:*; return the immutable version identifier. */
export interface CloudBrowserArtifactStore {
  putImmutable(input: { key: string; body: Uint8Array; contentType: string; sha256: string }): Promise<{ version: string }>;
  getVersion(input: { key: string; version: string; maxBytes: number }): Promise<{ body: Buffer; contentType: string }>;
}
/** Implement with SQS FIFO, MessageDeduplicationId=jobId and MessageGroupId=agent. */
export interface CloudBrowserQueue { enqueue(jobId: string, agent: string): Promise<void>; }
export interface CloudBrowserQueueMessage { id: string; receipt: string; jobId: string; agent: string; }
export interface CloudBrowserWorkerQueue extends CloudBrowserQueue {
  receive(maxMessages: number, visibilityTimeoutSeconds: number): Promise<CloudBrowserQueueMessage[]>;
  delete(receipt: string): Promise<void>;
  changeVisibility(receipt: string, visibilityTimeoutSeconds: number): Promise<void>;
}

export class BrowserJobError extends Error { constructor(readonly code: string, message = code) { super(message); } }

const AGENT = /^[a-z][a-z0-9-]{1,62}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_.:-]{8,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item);

function assertAgent(agent: string): void { if (!AGENT.test(agent)) throw new BrowserJobError('invalid_agent'); }
function assertLease(job: BrowserJob, agent: string, token: number, now: number): void {
  if (job.leaseOwner !== agent) throw new BrowserJobError('job_owner_mismatch');
  if (job.leaseToken !== token) throw new BrowserJobError('stale_lease');
  if (!job.leaseUntil || Date.parse(job.leaseUntil) <= now) throw new BrowserJobError('lease_expired');
}
function clone(job: BrowserJob): BrowserJob { return structuredClone(job); }

export class CloudBrowserJobs {
  constructor(private readonly store: CloudBrowserJobStore, private readonly queue: CloudBrowserQueue, private readonly artifacts: CloudBrowserArtifactStore, private readonly now: () => number = Date.now, private readonly newId: () => string = randomUUID) {}

  async submit(input: BrowserJobRequest): Promise<{ job: BrowserJob; replayed: boolean }> {
    assertAgent(input.agent);
    if (!IDEMPOTENCY.test(input.idempotencyKey)) throw new BrowserJobError('invalid_idempotency_key');
    const requestDigest = digest(canonical(input.request));
    const idempotencyDigest = digest(input.idempotencyKey);
    const existing = await this.store.readByIdempotency(input.agent, idempotencyDigest);
    if (existing) {
      if (existing.value.requestDigest !== requestDigest) throw new BrowserJobError('idempotency_conflict');
      if (existing.value.status === 'queued' && existing.value.dispatchState === 'pending') await this.dispatch(existing);
      return { job: existing.value, replayed: true };
    }
    const iso = new Date(this.now()).toISOString();
    const job: BrowserJob = { id: `bcj_${this.newId()}`, agent: input.agent, requestDigest, idempotencyDigest, request: structuredClone(input.request), status: 'queued', createdAt: iso, updatedAt: iso, leaseOwner: null, leaseUntil: null, leaseToken: 0, attempts: 0, cancellationRequestedAt: null, externalEffect: 'none', actionEffects: {}, dispatchState: 'pending', dispatchAttempts: 0, artifacts: [], errorCode: null };
    const created = await this.store.createIfAbsent(job);
    if (created === 'exists') {
      const raced = await this.store.readByIdempotency(input.agent, idempotencyDigest);
      if (!raced) throw new BrowserJobError('idempotency_read_after_conflict_failed');
      if (raced.value.requestDigest !== requestDigest) throw new BrowserJobError('idempotency_conflict');
      return { job: raced.value, replayed: true };
    }
    await this.dispatch({ value: job, version: '1' });
    return { job, replayed: false };
  }

  async get(jobId: string, agent: string): Promise<BrowserJob> { const hit = await this.required(jobId); if (hit.value.agent !== agent) throw new BrowserJobError('job_owner_mismatch'); return hit.value; }

  async claim(jobId: string, agent: string, leaseMs: number): Promise<BrowserJob> {
    assertAgent(agent);
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) throw new BrowserJobError('invalid_lease_duration');
    const hit = await this.required(jobId);
    const job = clone(hit.value); const now = this.now();
    if (job.agent !== agent) throw new BrowserJobError('job_owner_mismatch');
    if (job.status === 'cancelled' || job.status === 'succeeded' || job.status === 'failed' || job.status === 'needs_reconciliation') throw new BrowserJobError('job_terminal');
    if (job.leaseUntil && Date.parse(job.leaseUntil) > now) throw new BrowserJobError('lease_held');
    if (job.externalEffect === 'unknown') {
      job.status = 'needs_reconciliation'; job.errorCode = 'effect_reconciliation_required'; job.leaseOwner = null; job.leaseUntil = null;
      job.updatedAt = new Date(now).toISOString(); await this.replace(job, hit.version);
      throw new BrowserJobError('effect_reconciliation_required');
    }
    job.status = job.cancellationRequestedAt ? 'cancelling' : 'running'; job.leaseOwner = agent; job.leaseUntil = new Date(now + leaseMs).toISOString(); job.leaseToken++; job.attempts++; job.updatedAt = new Date(now).toISOString();
    await this.replace(job, hit.version); return job;
  }

  async heartbeat(jobId: string, agent: string, token: number, leaseMs: number): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value); const now = this.now(); assertLease(job, agent, token, now);
    if (job.status !== 'running' && job.status !== 'cancelling') throw new BrowserJobError('job_not_running');
    job.leaseUntil = new Date(now + leaseMs).toISOString(); job.updatedAt = new Date(now).toISOString(); await this.replace(job, hit.version); return job;
  }

  async requestCancellation(jobId: string, agent: string): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value); if (job.agent !== agent) throw new BrowserJobError('job_owner_mismatch');
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job;
    job.cancellationRequestedAt = new Date(this.now()).toISOString(); job.status = job.leaseOwner ? 'cancelling' : 'cancelled'; job.updatedAt = new Date(this.now()).toISOString(); await this.replace(job, hit.version); return job;
  }

  async beginExternalEffect(jobId: string, agent: string, token: number, step = 'default'): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value); const now = this.now(); assertLease(job, agent, token, now);
    if (job.status !== 'running') throw new BrowserJobError('job_not_running');
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(step) || job.actionEffects[step] === 'unknown' || job.actionEffects[step] === 'succeeded') throw new BrowserJobError('effect_reconciliation_required');
    job.externalEffect = 'unknown'; job.actionEffects[step] = 'unknown'; job.updatedAt = new Date(now).toISOString(); await this.replace(job, hit.version); return job;
  }

  /** Records a completed individual action without making the whole job terminal. */
  async recordExternalEffectSucceeded(jobId: string, agent: string, token: number, step: string): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value); const now = this.now(); assertLease(job, agent, token, now);
    if (job.actionEffects[step] !== 'unknown') throw new BrowserJobError('effect_not_uncertain');
    job.actionEffects[step] = 'succeeded'; job.externalEffect = Object.values(job.actionEffects).includes('unknown') ? 'unknown' : 'succeeded'; job.updatedAt = new Date(now).toISOString(); await this.replace(job, hit.version); return job;
  }

  async reconcileExternalEffect(jobId: string, agent: string, state: Exclude<ExternalEffectState, 'none' | 'unknown'>, step = 'default'): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value); if (job.agent !== agent) throw new BrowserJobError('job_owner_mismatch');
    if (job.actionEffects[step] !== 'unknown') throw new BrowserJobError('effect_not_uncertain');
    job.actionEffects[step] = state; job.externalEffect = Object.values(job.actionEffects).includes('unknown') ? 'unknown' : state; job.status = state === 'failed' ? 'failed' : 'queued'; job.leaseOwner = null; job.leaseUntil = null; job.errorCode = state === 'failed' ? 'external_effect_failed' : null; job.updatedAt = new Date(this.now()).toISOString(); await this.replace(job, hit.version); return job;
  }

  /** Fence an expired worker into a durable terminal reconciliation state before its queue message is removed. */
  async markNeedsReconciliation(jobId: string, agent: string, token: number, reason: string): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value);
    if (job.agent !== agent) throw new BrowserJobError('job_owner_mismatch');
    if (job.leaseToken !== token || job.leaseOwner !== agent) throw new BrowserJobError('stale_lease');
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'needs_reconciliation') return job;
    job.status = 'needs_reconciliation'; job.leaseOwner = null; job.leaseUntil = null; job.errorCode = reason; job.updatedAt = new Date(this.now()).toISOString(); await this.replace(job, hit.version); return job;
  }

  async complete(jobId: string, agent: string, token: number): Promise<BrowserJob> { return this.finish(jobId, agent, token, 'succeeded', null); }
  async fail(jobId: string, agent: string, token: number, code: string): Promise<BrowserJob> { return this.finish(jobId, agent, token, 'failed', code); }

  async attachArtifact(jobId: string, agent: string, token: number, body: Uint8Array, contentType: string, sha256: string): Promise<BrowserArtifactMetadata> {
    if (!SHA256.test(sha256) || createHash('sha256').update(body).digest('hex') !== sha256) throw new BrowserJobError('artifact_digest_mismatch');
    const hit = await this.required(jobId); const job = clone(hit.value); const now = this.now(); assertLease(job, agent, token, now);
    const id = `bca_${this.newId()}`; const key = `browser-cloud/${agent}/${jobId}/artifacts/${id}`;
    const stored = await this.artifacts.putImmutable({ key, body, contentType, sha256 });
    const metadata: BrowserArtifactMetadata = { id, jobId, agent, contentType, byteLength: body.byteLength, sha256, storageKey: key, storageVersion: stored.version, createdAt: new Date(now).toISOString() };
    job.artifacts.push(metadata); job.updatedAt = new Date(now).toISOString(); await this.replace(job, hit.version); return metadata;
  }

  private async finish(jobId: string, agent: string, token: number, status: 'succeeded' | 'failed', errorCode: string | null): Promise<BrowserJob> {
    const hit = await this.required(jobId); const job = clone(hit.value); const now = this.now(); assertLease(job, agent, token, now);
    if (job.externalEffect === 'unknown') throw new BrowserJobError('effect_reconciliation_required');
    job.status = job.cancellationRequestedAt ? 'cancelled' : status; job.errorCode = errorCode; job.leaseOwner = null; job.leaseUntil = null; job.updatedAt = new Date(now).toISOString(); await this.replace(job, hit.version); return job;
  }
  private async required(id: string): Promise<Versioned<BrowserJob>> { const hit = await this.store.readById(id); if (!hit) throw new BrowserJobError('job_not_found'); return hit; }
  private async replace(job: BrowserJob, version: string): Promise<void> { if (await this.store.replace(job, version) !== 'replaced') throw new BrowserJobError('concurrent_update'); }
  private async dispatch(hit: Versioned<BrowserJob>): Promise<void> {
    const job = clone(hit.value); if (job.dispatchState === 'dispatched') return;
    job.dispatchAttempts++; job.updatedAt = new Date(this.now()).toISOString();
    try { await this.queue.enqueue(job.id, job.agent); job.dispatchState = 'dispatched'; } catch { /* visible durable pending outbox below */ }
    await this.replace(job, hit.version);
  }
}
