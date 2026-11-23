import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { completeEsperHandoff, isConfigured, enqueue, enqueueEsperHandoff } from '../../agentstate/queue.js';
import { ESPER_HANDOFF_QUEUE, ESPER_HANDOFF_ROLES, type EsperHandoff } from '../../agentstate/queue-shared.js';

export interface AgentDispatchQueue {
  isConfigured: typeof isConfigured;
  enqueue: typeof enqueue;
  enqueueEsperHandoff?: typeof enqueueEsperHandoff;
  completeEsperHandoff?: typeof completeEsperHandoff;
}

const defaultQueue: AgentDispatchQueue = { isConfigured, enqueue, enqueueEsperHandoff, completeEsperHandoff };
const esperHandoffInput = z.object({
  task: z.enum(['summarize', 'extract']),
  source_document: z.string().regex(/^[a-z0-9][a-z0-9-]{3,94}$/),
}).strict();
const esperCompletionInput = z.object({
  message_id: z.string().uuid(),
  local_job: z.string().regex(/^esper-[0-9a-f]{24}$/),
}).strict();
const esperEnvelope = 'esper-local-ai';
const esperLegacySubject = 'esper-local-ai:v1';
const esperLegacyBody = /^(summarize|extract) ([a-z0-9][a-z0-9-]{3,94})$/;

function parseEsperLegacyEnvelope(subject: string, body: string): z.infer<typeof esperHandoffInput> {
  const parts = body.length <= 105 ? esperLegacyBody.exec(body) : null;
  if (subject !== esperLegacySubject || !parts || parts[0] !== body) {
    throw new Error('Esper compatibility requests require only an approved task and exact source ID.');
  }
  return esperHandoffInput.parse({ task: parts[1], source_document: parts[2] });
}

export interface AgentDispatchInput {
  to_agent: string;
  subject: string;
  body: string;
  from_agent: string;
  task_id?: string;
  esper_handoff?: Omit<EsperHandoff, 'role'>;
  esper_completion?: z.infer<typeof esperCompletionInput>;
}

/** The receipt contains the backend's persisted native message ID, when that backend returns one. */
export async function handleAgentDispatch(
  input: AgentDispatchInput,
  ctx: ToolContext,
  queue: AgentDispatchQueue = defaultQueue,
): Promise<ToolResultPayload> {
  if (input.to_agent === ESPER_HANDOFF_QUEUE || input.subject === esperLegacySubject
      || input.esper_handoff || input.esper_completion) {
    const role = ESPER_HANDOFF_ROLES.find((allowed) => allowed === ctx.callerAgent);
    const typed = input.esper_handoff || input.esper_completion;
    if (!role || input.from_agent !== role || input.to_agent !== ESPER_HANDOFF_QUEUE || input.task_id !== undefined
        || (typed && (input.subject !== esperEnvelope || input.body !== esperEnvelope))) {
      throw new Error('Esper requires the authenticated company role, CTO recipient and metadata-only envelope.');
    }
    if (input.esper_completion) {
      if (role !== 'cto' || input.esper_handoff) {
        throw new Error('Esper completion requires a separate request from the authenticated CTO role.');
      }
      const completion = esperCompletionInput.parse(input.esper_completion);
      if (ctx.dryRun) {
        return { data: { dispatched: false, to: 'cto' }, summary: 'DRY RUN: would mark one exact Esper request complete.' };
      }
      if (!queue.completeEsperHandoff) throw new Error('Esper request queue is unavailable.');
      const completed = await queue.completeEsperHandoff(completion.message_id, completion.local_job);
      return {
        data: { dispatched: false, to: 'cto', message_id: completion.message_id, esper_completed: completed },
        summary: completed ? 'The exact Esper request is complete.' : 'The exact Esper request is unavailable or already has a different result.',
        ...(completed ? { audit: { after: completion } } : {}),
      };
    }
    const handoff = input.esper_handoff
      ? esperHandoffInput.parse(input.esper_handoff)
      : parseEsperLegacyEnvelope(input.subject, input.body);
    const request: EsperHandoff = { ...handoff, role };
    if (ctx.dryRun) {
      return { data: { dispatched: false, to: 'cto' }, summary: 'DRY RUN: would enqueue one Esper request.' };
    }
    if (!queue.enqueueEsperHandoff) throw new Error('Esper request queue is unavailable.');
    const result = await queue.enqueueEsperHandoff(request);
    return {
      data: { dispatched: result.created, to: 'cto', message_id: result.message_id, esper_status: result.state,
        ...(result.local_job ? { local_job: result.local_job } : {}) },
      summary: result.created ? 'Enqueued one source-linked Esper request.' : `The original Esper request is ${result.state}.`,
      ...(result.created ? { audit: { after: { ...request, message_id: result.message_id } } } : {}),
    };
  }
  if (!queue.isConfigured()) return { data: { dispatched: false, note: 'agent inbox not configured on the gateway.' }, summary: 'Inbox not configured.' };
  if (ctx.dryRun) return { data: { dispatched: false, preview: input, note: 'dry_run: pass dry_run=false to send.' }, summary: `DRY RUN: would dispatch to ${input.to_agent}.` };
  const msg = { to: input.to_agent, from: input.from_agent, subject: input.subject, body: input.body, ts: new Date().toISOString(), ...(input.task_id ? { task_id: input.task_id } : {}) };
  const messageId = await queue.enqueue(input.to_agent, msg);
  const receipt = messageId ? { message_id: messageId } : {};
  return {
    data: { dispatched: true, to: input.to_agent, ...receipt },
    summary: `Dispatched "${input.subject}" to ${input.to_agent}'s inbox.`,
    audit: { after: { ...msg, ...receipt } },
  };
}

export function registerAgentDispatch(server: McpServer, callerHash: CallerHashProvider, queue: AgentDispatchQueue = defaultQueue): void {
  registerTool(
    server,
    {
      name: 'agent_dispatch',
      category: 'write_simple',
      annotations: {
        title: 'Dispatch a message to an agent inbox',
        description:
          'Enqueue a durable message to another agent\'s inbox (Azure Storage Queue). The "poke the other agent now" channel that pairs with the work-ledger: create a task in the ledger, then dispatch so the target agent sees it on its next turn. Pass dry_run=false to send. Non-sensitive content only.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        to_agent: z.string().describe('Recipient agent (lowercase id).'),
        subject: z.string().min(1).describe('Short subject line.'),
        body: z.string().min(1).describe('The message body (non-sensitive).'),
        from_agent: z.string().describe('Sender agent id (or "matt").'),
        task_id: z.string().optional().describe('Optional related work-ledger task id.'),
        esper_handoff: esperHandoffInput.optional().describe('Request Esper processing of one approved company-shared Hindsight ID. Use esper:cto:local-ai:v1 as recipient, the authenticated role as sender, esper-local-ai as both subject and body, and omit task_id.'),
        esper_completion: esperCompletionInput.optional().describe('CTO only. Mark a dedicated Esper request complete after verifying its durable local result. Use cto as sender, esper:cto:local-ai:v1 as recipient, esper-local-ai as both subject and body, and omit task_id.'),
      },
      outputShape: { dispatched: z.boolean(), to: z.string().optional(), message_id: z.string().optional(),
        esper_completed: z.boolean().optional(), esper_status: z.enum(['pending', 'completed', 'expired']).optional(),
        local_job: z.string().optional() },
      handler: (input, ctx) => handleAgentDispatch(input, ctx, queue),
    },
    callerHash,
  );
}
