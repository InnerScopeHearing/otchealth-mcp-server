import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serviceAuthorized } from './chat-action-jobs.js';
import { runQueuedChatActionJob, type ChatActionWorkerDeps } from './chat-action-worker.js';

const Input = z.object({ job_id: z.string().regex(/^caj_[a-f0-9]{64}$/), caller_hash: z.string().min(8).max(255) }).strict();

/** Service-only n8n execution hook. The executor is supplied by the runtime so this route never
 * performs HTTP loopback or trusts an n8n-supplied seat identity. */
export function registerChatActionRunRoute(app: FastifyInstance, deps: ChatActionWorkerDeps): void {
  app.post('/internal/chat-actions/jobs/run', async (request, reply) => {
    if (!serviceAuthorized(request.headers as Record<string, unknown>)) return reply.code(401).send({ success: false, error: 'chat_action_service_unauthorized' });
    const parsed = Input.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: 'invalid_chat_action_run' });
    try {
      const result = await runQueuedChatActionJob(parsed.data.job_id, parsed.data.caller_hash, deps);
      return reply.send({ success: true, result });
    } catch (error) {
      return reply.code(404).send({ success: false, error: (error as Error).message });
    }
  });
}
