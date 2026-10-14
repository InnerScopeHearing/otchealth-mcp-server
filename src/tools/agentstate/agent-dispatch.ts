import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';
import { isConfigured, enqueue } from '../../agentstate/queue.js';

export interface AgentDispatchQueue {
  isConfigured: typeof isConfigured;
  enqueue: typeof enqueue;
}

const defaultQueue: AgentDispatchQueue = { isConfigured, enqueue };

export interface AgentDispatchInput {
  to_agent: string;
  subject: string;
  body: string;
  from_agent: string;
  task_id?: string;
}

/** The receipt contains the backend's persisted native message ID, when that backend returns one. */
export async function handleAgentDispatch(
  input: AgentDispatchInput,
  ctx: ToolContext,
  queue: AgentDispatchQueue = defaultQueue,
): Promise<ToolResultPayload> {
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
      },
      outputShape: { dispatched: z.boolean(), to: z.string().optional(), message_id: z.string().optional() },
      handler: (input, ctx) => handleAgentDispatch(input, ctx, queue),
    },
    callerHash,
  );
}
