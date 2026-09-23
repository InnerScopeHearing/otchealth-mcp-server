import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { CHAT_ACTIONS, getChatActionJob, getChatActionResult, rejectPersonalLegalInput, submitChatAction } from '../../n8n/chat-action-client.js';

const requestShape = z.record(z.unknown());

export function registerN8nChatActions(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'chat_action_submit',
    category: 'write_orchestrated',
    annotations: { title: 'Submit a durable n8n Chat action', description: 'Submit one allowlisted Brain read or checkpoint action to the durable n8n job bridge.', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    connectorInputShape: { action: z.enum(CHAT_ACTIONS), request: requestShape, idempotency_key: z.string().min(8).max(255) },
    inputShape: {
      action: z.enum(CHAT_ACTIONS).describe('Allowlisted action: brain_search or checkpoint.'),
      request: requestShape.describe('Action request. Do not include secrets, PHI, or personal-legal content.'),
      idempotency_key: z.string().min(8).max(255).describe('Stable retry key. Reusing it returns the original durable job.'),
    },
    outputShape: { job_id: z.string().optional(), status: z.string().optional(), submitted: z.boolean(), dry_run: z.boolean().optional(), reason: z.string().optional() },
    handler: async (input, ctx) => {
      const refusal = ctx.callerAgent === 'clo-personal' ? 'clo-personal is not available through the ordinary Chat action bridge' : rejectPersonalLegalInput(input.request);
      if (refusal) return { data: { submitted: false, reason: refusal }, summary: `Refused: ${refusal}.` };
      if (ctx.dryRun) return { data: { submitted: false, dry_run: true, reason: 'dry_run: no n8n job created.' }, summary: `DRY RUN: would submit ${input.action}.` };
      const job = await submitChatAction({ action: input.action, request: input.request, idempotencyKey: input.idempotency_key, callerHash: ctx.callerHash, callerAgent: ctx.callerAgent, correlationId: ctx.correlationId });
      return { data: { submitted: true, job_id: job.job_id, status: job.status }, summary: `Submitted ${input.action} as durable job ${job.job_id}.` };
    },
  }, callerHash);

  const readShape = { job_id: z.string().min(1) };
  for (const spec of [
    { name: 'chat_action_status' as const, title: 'Get n8n Chat action status', run: getChatActionJob },
    { name: 'chat_action_result' as const, title: 'Get n8n Chat action result', run: getChatActionResult },
  ]) {
    registerTool(server, {
      name: spec.name,
      category: 'read',
      annotations: { title: spec.title, description: 'Read an ordinary Chat action by its opaque durable job id.', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      connectorInputShape: readShape,
      inputShape: { job_id: z.string().min(1).describe('Opaque job id returned by chat_action_submit.') },
      outputShape: { job_id: z.string(), status: z.string(), result: z.unknown().optional(), error: z.string().optional() },
      handler: async (input, ctx) => {
        const job = await spec.run({ jobId: input.job_id, callerHash: ctx.callerHash, correlationId: ctx.correlationId });
        return { data: job, summary: `Job ${job.job_id} is ${job.status}.` };
      },
    }, callerHash);
  }
}
