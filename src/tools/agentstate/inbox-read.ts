import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { acknowledgeMessage, isConfigured, readEsperHandoffs, readMessages, supportsExactAcknowledgment } from '../../agentstate/queue.js';
import { ESPER_HANDOFF_QUEUE } from '../../agentstate/queue-shared.js';

interface InboxQueue {
  isConfigured: typeof isConfigured;
  supportsExactAcknowledgment: typeof supportsExactAcknowledgment;
  acknowledgeMessage: typeof acknowledgeMessage;
  readMessages: typeof readMessages;
  readEsperHandoffs?: typeof readEsperHandoffs;
}

const defaultQueue: InboxQueue = { isConfigured, supportsExactAcknowledgment, acknowledgeMessage, readMessages, readEsperHandoffs };

export function registerInboxRead(server: McpServer, callerHash: CallerHashProvider, queue: InboxQueue = defaultQueue): void {
  registerTool(
    server,
    {
      name: 'inbox_read',
      category: 'read',
      annotations: {
        title: 'Read an agent inbox',
        description:
          'Read (and by default drain) an agent inbox, or acknowledge one previously observed Postgres message by expected_message_id. Exact acknowledgment is atomic, restricted to the authenticated caller\'s own inbox, and unsupported on Azure. Durable enqueue does not wake an idle persistent-role chat. ack=false peeks do not consume messages; newest_first requires ack=false. Expired, overage, and over-delivered messages are ineligible for exact acknowledgment; dead_letter=true lists dead letters for audit.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Whose inbox to read (lowercase id).'),
        max: z.number().int().min(1).max(32).optional().describe('Max messages to read (default 16).'),
        ack: z.boolean().optional().describe('Delete after reading (default true). false = peek; selected messages are not consumed or counted as deliveries.'),
        newest_first: z.boolean().optional().describe('Return selected live messages newest first. Requires ack=false and Postgres; no selected message is consumed, leased, or counted as a delivery. Inbox dead-letter housekeeping still applies.'),
        dead_letter: z.boolean().optional().describe('Audit: list dead-lettered messages (newest first) instead of live ones. Read-only; ack is ignored.'),
        expected_message_id: z.string().uuid().optional().describe('Atomically acknowledge exactly this previously observed message ID in your own inbox. Cannot be combined with drain, peek, or dead-letter mode.'),
        esper_handoff: z.object({
          after_message_id: z.string().uuid().optional(),
        }).strict().optional().describe('CTO only. Read metadata from the dedicated Esper queue. Set agent to esper:cto:local-ai:v1 and ack to false. Use the last result ID for the next page.'),
      },
      outputShape: { count: z.number(), messages: z.unknown() },
      handler: async (input, ctx) => {
        if (input.esper_handoff) {
          if (ctx.callerAgent !== 'cto' || input.agent !== ESPER_HANDOFF_QUEUE) {
            throw new Error('Esper handoffs are available only to the authenticated CTO role.');
          }
          if (input.ack !== false || input.expected_message_id !== undefined
              || input.newest_first !== undefined || input.dead_letter !== undefined) {
            throw new Error('Esper handoff peeks require ack=false and cannot be combined with other inbox modes.');
          }
          if (!queue.readEsperHandoffs) throw new Error('Esper request queue is unavailable.');
          const messages = await queue.readEsperHandoffs(input.max ?? 16, input.esper_handoff.after_message_id);
          return { data: { count: messages.length, messages }, summary: `${messages.length} pending Esper request(s).` };
        }
        if (input.expected_message_id) {
          if (input.ack !== undefined || input.newest_first !== undefined || input.dead_letter !== undefined || input.max !== undefined) {
            throw new Error('expected_message_id cannot be combined with ack, max, newest_first, or dead_letter.');
          }
          if (!ctx.callerAgent || input.agent.toLowerCase() !== ctx.callerAgent.toLowerCase()) {
            throw new Error('Exact acknowledgment is restricted to the authenticated caller’s own inbox.');
          }
          if (!queue.supportsExactAcknowledgment()) throw new Error('Exact message acknowledgment is unsupported by the active Azure Queue backend.');
          if (!queue.isConfigured()) throw new Error('Exact message acknowledgment is unavailable because the inbox backend is not configured.');
          const acknowledged = await queue.acknowledgeMessage(ctx.callerAgent, input.expected_message_id);
          return { data: { count: 0, messages: [], acknowledged, message_id: input.expected_message_id, outcome: acknowledged ? 'acknowledged' : 'not_acknowledged' }, summary: acknowledged ? 'Exact message acknowledged.' : 'Exact message was absent or no longer eligible.' };
        }
        if (input.newest_first && ((input.ack ?? true) || input.dead_letter)) {
          throw new Error('newest_first is supported only for live read-only peeks; set ack=false and omit dead_letter.');
        }
        if (!queue.isConfigured()) return { data: { count: 0, messages: [], note: 'agent inbox not configured.' }, summary: 'Inbox not configured.' };
        const deadLetter = input.dead_letter === true;
        const ack = deadLetter ? false : (input.ack ?? true);
        const messages = await queue.readMessages(input.agent, { max: input.max ?? 16, ack, deadLetter, newestFirst: input.newest_first });
        const mode = deadLetter ? ' (dead letters, read-only)' : ack ? ' (drained)' : ' (peeked)';
        return { data: { count: messages.length, messages }, summary: `${messages.length} message(s) in ${input.agent}'s inbox${mode}.` };
      },
    },
    callerHash,
  );
}
