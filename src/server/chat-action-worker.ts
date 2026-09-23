import { queryDocs, readDoc, replaceDoc } from '../agentstate/store.js';
import { rejectPersonalLegalInput } from '../n8n/chat-action-client.js';
import type { ChatActionJob } from './chat-action-jobs.js';

export interface ChatActionExecutor {
  brainSearch(request: Record<string, unknown>, callerHash: string): Promise<unknown>;
  checkpoint(request: Record<string, unknown>, callerHash: string): Promise<unknown>;
}

export interface ChatActionWorkerDeps {
  queryDocs: typeof queryDocs;
  readDoc: typeof readDoc;
  replaceDoc: typeof replaceDoc;
  execute: ChatActionExecutor;
}

const JOBS = 'events';
const DEFAULT_DEPS: ChatActionWorkerDeps = { queryDocs, readDoc, replaceDoc, execute: {
  brainSearch: async () => { throw new Error('chat_action_brain_executor_unconfigured'); },
  checkpoint: async () => { throw new Error('chat_action_checkpoint_executor_unconfigured'); },
} };

function terminal(job: ChatActionJob, status: 'succeeded' | 'failed', result?: unknown, error?: string): ChatActionJob {
  return { ...job, status, ...(result === undefined ? {} : { result }), ...(error ? { error: error.slice(0, 500) } : {}), updated_at: new Date().toISOString() };
}

export async function runQueuedChatActionJob(
  jobId: string,
  callerHash: string,
  deps: ChatActionWorkerDeps = DEFAULT_DEPS,
): Promise<{ status: ChatActionJob['status']; job_id: string }> {
  const current = await deps.readDoc(JOBS, jobId, jobId) as ChatActionJob | null;
  if (!current || current.type !== 'chat_action_job' || current.caller_hash !== callerHash) throw new Error('chat_action_job_not_found');
  if (current.status !== 'queued') return { status: current.status, job_id: current.id };
  if (!['brain_search', 'checkpoint'].includes(current.action)) throw new Error('chat_action_action_not_allowed');
  const refusal = rejectPersonalLegalInput(current.request);
  if (refusal) throw new Error(refusal);
  const running = { ...current, status: 'running' as const, updated_at: new Date().toISOString() };
  await deps.replaceDoc(JOBS, jobId, jobId, running as unknown as Record<string, unknown>);
  try {
    const result = current.action === 'brain_search'
      ? await deps.execute.brainSearch(current.request, current.caller_hash)
      : await deps.execute.checkpoint(current.request, current.caller_hash);
    const done = terminal(running, 'succeeded', result);
    await deps.replaceDoc(JOBS, jobId, jobId, done as unknown as Record<string, unknown>);
    return { status: done.status, job_id: done.id };
  } catch (error) {
    const failed = terminal(running, 'failed', undefined, error instanceof Error ? error.message : String(error));
    await deps.replaceDoc(JOBS, jobId, jobId, failed as unknown as Record<string, unknown>);
    return { status: failed.status, job_id: failed.id };
  }
}

export async function runNextQueuedChatActionJob(
  callerHash: string,
  deps: ChatActionWorkerDeps = DEFAULT_DEPS,
): Promise<{ status: ChatActionJob['status']; job_id: string } | null> {
  const rows = await deps.queryDocs(JOBS, 'SELECT * FROM c WHERE c.type = @type AND c.status = @status ORDER BY c.created_at', [
    { name: '@type', value: 'chat_action_job' }, { name: '@status', value: 'queued' },
  ], { max: 1 });
  const job = rows[0] as unknown as ChatActionJob | undefined;
  return job ? runQueuedChatActionJob(job.id, callerHash, deps) : null;
}
