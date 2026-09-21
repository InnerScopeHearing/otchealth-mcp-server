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
      let run: BrowserJob | undefined;
      try {
        run = await this.jobs.claim(message.jobId, message.agent, this.leaseMs);
        if (!run) throw new BrowserJobError('job_not_found');
        const claimed = run;
        if (Object.values(claimed.actionEffects).includes('succeeded')) throw new BrowserJobError('session_resume_reconciliation_required');
        await this.executor.execute(claimed, {
          beginExternalEffect: async (step) => { await this.jobs.beginExternalEffect(claimed.id, claimed.agent, claimed.leaseToken, step); },
          heartbeat: async () => { const current = await this.jobs.heartbeat(claimed.id, claimed.agent, claimed.leaseToken, this.leaseMs); await this.queue.changeVisibility(message.receipt, Math.ceil(this.leaseMs / 1000)); return current.cancellationRequestedAt !== null; },
          cancellationRequested: () => claimed.cancellationRequestedAt !== null,
        });
        await this.jobs.complete(claimed.id, claimed.agent, claimed.leaseToken); await this.queue.delete(message.receipt); completed++;
      } catch (error) {
        if (error instanceof BrowserJobError && error.code === 'lease_expired') {
          try { const current = await this.jobs.get(message.jobId, message.agent); const hasEffect = current.externalEffect === 'unknown' || Object.values(current.actionEffects).some(state => state === 'unknown' || state === 'succeeded'); if (hasEffect && run) { await this.jobs.markNeedsReconciliation(run.id, run.agent, run.leaseToken, 'lease_expired_after_browser_action'); await this.queue.delete(message.receipt); reconciliations++; } else { heldForRetry++; } } catch { heldForRetry++; }
          continue;
        }
        if (error instanceof BrowserJobError && (error.code === 'effect_reconciliation_required' || error.code === 'session_resume_reconciliation_required' || error.code === 'job_terminal')) {
          try {
            if (run) await this.jobs.markNeedsReconciliation(run.id, run.agent, run.leaseToken, error.code);
            const current = await this.jobs.get(message.jobId, message.agent);
            if (!['succeeded', 'failed', 'cancelled', 'needs_reconciliation'].includes(current.status)) { heldForRetry++; continue; }
            await this.queue.delete(message.receipt); reconciliations++;
          } catch { heldForRetry++; }
          continue;
        }
        // An action that had been marked unknown is intentionally left durable for reconciliation.
        // Delete its delivery to avoid a blind provider repeat. Safe pre-effect failures remain retryable.
        if (error instanceof BrowserJobError && error.code === 'concurrent_update') { heldForRetry++; continue; }
        try { const job = await this.jobs.get(message.jobId, message.agent); if (job.externalEffect === 'unknown' && run) { await this.jobs.markNeedsReconciliation(run.id, run.agent, run.leaseToken, 'browser_action_outcome_unknown'); await this.queue.delete(message.receipt); reconciliations++; } else { heldForRetry++; } } catch { heldForRetry++; }
      }
    }
    return { received: messages.length, completed, heldForRetry, reconciliations };
  }
}
