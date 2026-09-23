import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDoc, isConfigured, readDoc } from '../agentstate/store.js';
import { rejectPersonalLegalInput, CHAT_ACTIONS } from '../n8n/chat-action-client.js';

const COMPANY_LANES = new Set(['cto', 'developer', 'coo', 'cro', 'cfo', 'clo', 'exec']);
const Submit = z.object({ action: z.enum(CHAT_ACTIONS), request: z.record(z.unknown()), idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,255}$/), correlation_id: z.string().min(1).max(255), caller_hash: z.string().min(8).max(255), caller_agent: z.string().min(1).max(64) }).strict();
const Read = z.object({ job_id: z.string().regex(/^caj_[a-f0-9]{64}$/), caller_hash: z.string().min(8).max(255) }).strict();
const JOBS = 'events';
const SERVICE_TOKEN_ENV = 'N8N_GATEWAY_SERVICE_TOKEN';

export interface ChatActionJob {
  id: string;
  type: 'chat_action_job';
  caller_hash: string;
  caller_agent: string;
  action: (typeof CHAT_ACTIONS)[number];
  request: Record<string, unknown>;
  idempotency_key_hash: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result?: unknown;
  error?: string;
  created_at: string;
  updated_at: string;
}

function digest(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function jobId(caller: string, key: string): string { return `caj_${digest(`${caller}\u0000${key}`)}`; }
function sameSecret(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || expected.length < 32) return false;
  const a = createHash('sha256').update(value).digest(); const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
export function serviceAuthorized(headers: Record<string, unknown>): boolean {
  const token = process.env[SERVICE_TOKEN_ENV];
  const supplied = headers['x-otchealth-service-token'] ?? headers['authorization']?.toString().replace(/^Bearer\s+/i, '');
  return Boolean(token && sameSecret(supplied, token));
}
function project(job: ChatActionJob): Record<string, unknown> {
  return { job_id: job.id, status: job.status, ...(job.result !== undefined ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
}

export async function createChatActionJob(input: z.infer<typeof Submit>, deps = { createDoc, readDoc, configured: isConfigured }): Promise<{ job: ChatActionJob; replayed: boolean }> {
  const refusal = rejectPersonalLegalInput(input.request);
  if (refusal) throw new Error(refusal);
  if (!COMPANY_LANES.has(input.caller_agent)) throw new Error('chat_action_caller_lane_not_allowed');
  const id = jobId(input.caller_hash, input.idempotency_key);
  const existing = await deps.readDoc(JOBS, id, id) as ChatActionJob | null;
  const payloadHash = digest(JSON.stringify({ action: input.action, request: input.request, caller_hash: input.caller_hash, caller_agent: input.caller_agent }));
  if (existing) {
    if (existing.idempotency_key_hash !== digest(`${input.caller_hash}\u0000${input.idempotency_key}`) || existing.action !== input.action || existing.caller_agent !== input.caller_agent || digest(JSON.stringify({ action: existing.action, request: existing.request, caller_hash: existing.caller_hash, caller_agent: existing.caller_agent })) !== payloadHash) throw new Error('chat_action_idempotency_conflict');
    return { job: existing, replayed: true };
  }
  const now = new Date().toISOString();
  const job: ChatActionJob = { id, type: 'chat_action_job', caller_hash: input.caller_hash, caller_agent: input.caller_agent, action: input.action, request: input.request, idempotency_key_hash: digest(`${input.caller_hash}\u0000${input.idempotency_key}`), status: 'queued', created_at: now, updated_at: now };
  try { await deps.createDoc(JOBS, id, job as unknown as Record<string, unknown>); } catch (error) {
    const replay = await deps.readDoc(JOBS, id, id) as ChatActionJob | null;
    if (replay) return { job: replay, replayed: true };
    throw error;
  }
  return { job, replayed: false };
}

export function registerChatActionJobRoutes(app: FastifyInstance): void {
  const route = async (request: any, reply: any, mode: 'submit' | 'status' | 'result') => {
    if (!serviceAuthorized(request.headers as Record<string, unknown>)) return reply.code(401).send({ success: false, error: 'chat_action_service_unauthorized' });
    if (!isConfigured()) return reply.code(503).send({ success: false, error: 'chat_action_state_unavailable' });
    if (mode === 'submit') {
      const parsed = Submit.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ success: false, error: 'invalid_chat_action_submit' });
      try { const out = await createChatActionJob(parsed.data); return reply.code(out.replayed ? 200 : 201).send({ success: true, result: { job_id: out.job.id, status: out.job.status } }); } catch (error) { return reply.code(409).send({ success: false, error: (error as Error).message }); }
    }
    const parsed = Read.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ success: false, error: 'invalid_chat_action_read' });
    const job = await readDoc(JOBS, parsed.data.job_id, parsed.data.job_id) as ChatActionJob | null;
    if (!job || job.type !== 'chat_action_job' || job.caller_hash !== parsed.data.caller_hash) return reply.code(404).send({ success: false, error: 'chat_action_job_not_found' });
    return reply.send({ success: true, result: mode === 'status' ? { job_id: job.id, status: job.status } : project(job) });
  };
  app.post('/internal/chat-actions/jobs', (req, rep) => route(req, rep, 'submit'));
  app.post('/internal/chat-actions/jobs/status', (req, rep) => route(req, rep, 'status'));
  app.post('/internal/chat-actions/jobs/result', (req, rep) => route(req, rep, 'result'));
}
