/** Narrow n8n bridge used by ordinary Chat connectors.
 *
 * n8n owns the durable execution record. The gateway only submits an allowlisted
 * action and later reads the job record by opaque id. The three webhook contracts
 * are intentionally separate so a timeout on submission never gets mistaken for
 * a completed action.
 */
import { callN8nWebhook, type N8nWebhookResponse } from './webhook-client.js';

export const CHAT_ACTIONS = ['brain_search', 'checkpoint'] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

export const CHAT_ACTION_PATHS = {
  submit: '/webhook/chat-action-submit',
  status: '/webhook/chat-action-status',
  result: '/webhook/chat-action-result',
} as const;

export interface ChatActionJob {
  job_id: string;
  status: string;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
}

/** Personal legal content must never cross this bridge, even if a future caller
 * accidentally places the lane in a nested request field. */
export function rejectPersonalLegalInput(value: unknown): string | null {
  if (value === 'clo-personal') return 'clo-personal is not available through the ordinary Chat action bridge';
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = rejectPersonalLegalInput(item);
      if (reason) return reason;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'agent' || key === 'scope' || key === 'room') {
        if (typeof item === 'string' && item.trim().toLowerCase() === 'clo-personal') {
          return 'clo-personal is not available through the ordinary Chat action bridge';
        }
      }
      const reason = rejectPersonalLegalInput(item);
      if (reason) return reason;
    }
  }
  return null;
}

function requireJob(response: N8nWebhookResponse): ChatActionJob {
  const body = response.result;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('n8n_chat_action_invalid_job');
  const job = body as Record<string, unknown>;
  if (typeof job.job_id !== 'string' || !job.job_id || typeof job.status !== 'string' || !job.status) {
    throw new Error('n8n_chat_action_invalid_job');
  }
  return job as ChatActionJob;
}

export async function submitChatAction(args: {
  action: ChatAction;
  request: Record<string, unknown>;
  idempotencyKey: string;
  callerHash: string;
  correlationId: string;
}): Promise<ChatActionJob> {
  const refusal = rejectPersonalLegalInput(args.request);
  if (refusal) throw new Error(refusal);
  const response = await callN8nWebhook({
    webhookPath: CHAT_ACTION_PATHS.submit,
    payload: { action: args.action, request: args.request, idempotency_key: args.idempotencyKey },
    toolName: 'chat_action_submit', callerHash: args.callerHash, correlationId: args.correlationId,
  });
  return requireJob(response);
}

export async function getChatActionJob(args: { jobId: string; callerHash: string; correlationId: string }): Promise<ChatActionJob> {
  const response = await callN8nWebhook({
    webhookPath: CHAT_ACTION_PATHS.status,
    payload: { job_id: args.jobId, caller_hash: args.callerHash },
    toolName: 'chat_action_status', callerHash: args.callerHash, correlationId: args.correlationId,
  });
  return requireJob(response);
}

export async function getChatActionResult(args: { jobId: string; callerHash: string; correlationId: string }): Promise<ChatActionJob> {
  const response = await callN8nWebhook({
    webhookPath: CHAT_ACTION_PATHS.result,
    payload: { job_id: args.jobId, caller_hash: args.callerHash },
    toolName: 'chat_action_result', callerHash: args.callerHash, correlationId: args.correlationId,
  });
  return requireJob(response);
}
