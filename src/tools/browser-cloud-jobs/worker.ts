import { BrowserJobError, CloudBrowserJobs, type BrowserJob, type CloudBrowserWorkerQueue } from './contracts.js';

export interface CloudBrowserPlanExecutor {
  execute(job: BrowserJob, control: { beginExternalEffect(step: string): Promise<void>; heartbeat(): Promise<boolean>; cancellationRequested(): boolean }): Promise<unknown>;
}

/** One bounded poll. The executor owns browser-plan interpretation, while this worker owns durable lease and queue acknowledgement. */
export class CloudBrowserJobWorker {
  constructor(private readonly jobs: CloudBrowserJobs, private readonly queue: CloudBrowserWorkerQueue, private readonly executor: CloudBrowserPlanExecutor, private readonly leaseMs = 60_000) {}
  async pollOnce(maxMessages = 1): Promise<{ received: number; completed: number; heldForRetry: number; reconciliations: number }> {
    const messages = await this.queue.receive(Math.min(Math.max(1, maxMessages), 10), Math.ceil(this.leaseMs / 1000)); let completed = 0; let heldForRetry = 0; let reconciliations = 0;
    for (const message of messages) {
      try {
        const run = await this.jobs.claim(message.jobId, message.agent, this.leaseMs);
        if (Object.values(run.actionEffects).includes('succeeded')) throw new BrowserJobError('session_resume_reconciliation_required');
        await this.executor.execute(run, {
          beginExternalEffect: async (step) => { await this.jobs.beginExternalEffect(run.id, run.agent, run.leaseToken, step); },
          heartbeat: async () => { const current = await this.jobs.heartbeat(run.id, run.agent, run.leaseToken, this.leaseMs); await this.queue.changeVisibility(message.receipt, Math.ceil(this.leaseMs / 1000)); return current.cancellationRequestedAt !== null; },
          cancellationRequested: () => run.cancellationRequestedAt !== null,
        });
        await this.jobs.complete(run.id, run.agent, run.leaseToken); await this.queue.delete(message.receipt); completed++;
      } catch (error) {
        if (error instanceof BrowserJobError && (error.code === 'effect_reconciliation_required' || error.code === 'lease_expired' || error.code === 'session_resume_reconciliation_required' || error.code === 'job_terminal')) { await this.queue.delete(message.receipt); reconciliations++; continue; }
        // An action that had been marked unknown is intentionally left durable for reconciliation.
        // Delete its delivery to avoid a blind provider repeat. Safe pre-effect failures remain retryable.
        if (error instanceof BrowserJobError && error.code === 'concurrent_update') { heldForRetry++; continue; }
        try { const job = await this.jobs.get(message.jobId, message.agent); if (job.externalEffect === 'unknown') { await this.queue.delete(message.receipt); reconciliations++; } else { heldForRetry++; } } catch { heldForRetry++; }
      }
    }
    return { received: messages.length, completed, heldForRetry, reconciliations };
  }
}
