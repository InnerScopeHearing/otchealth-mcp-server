import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, enqueue } from '../../agentstate/queue.js';

export function registerAgentDispatch(server: McpServer, callerHash: CallerHashProvider): void {
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
      outputShape: { dispatched: z.boolean() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { dispatched: false, note: 'agent inbox not configured on the gateway.' }, summary: 'Inbox not configured.' };
        if (ctx.dryRun) return { data: { dispatched: false, preview: input, note: 'dry_run: pass dry_run=false to send.' }, summary: `DRY RUN: would dispatch to ${input.to_agent}.` };
        const msg = { to: input.to_agent, from: input.from_agent, subject: input.subject, body: input.body, ts: new Date().toISOString(), ...(input.task_id ? { task_id: input.task_id } : {}) };
        await enqueue(input.to_agent, msg);
        return { data: { dispatched: true, to: input.to_agent }, summary: `Dispatched "${input.subject}" to ${input.to_agent}'s inbox.`, audit: { after: msg } };
      },
    },
    callerHash,
  );
}
