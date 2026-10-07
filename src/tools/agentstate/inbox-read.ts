import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, readMessages } from '../../agentstate/queue.js';

export function registerInboxRead(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'inbox_read',
      category: 'read',
      annotations: {
        title: 'Read an agent inbox',
        description:
          'Read (and by default drain) the messages waiting in an agent\'s inbox. This is how an agent picks up cross-engine handoffs on wake. ack=true (default) removes the messages after reading; ack=false peeks: read-only, nothing is hidden, removed or counted as a delivery. Messages past their TTL, older than 7 days, or delivered more than 50 times are dead-lettered: they stop appearing in peeks, drains and wake, and dead_letter=true lists them for audit.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Whose inbox to read (lowercase id).'),
        max: z.number().int().min(1).max(32).optional().describe('Max messages to read (default 16).'),
        ack: z.boolean().optional().describe('Delete after reading (default true). false = peek (no side effects).'),
        dead_letter: z.boolean().optional().describe('Audit: list dead-lettered messages (newest first) instead of live ones. Read-only; ack is ignored.'),
      },
      outputShape: { count: z.number(), messages: z.unknown() },
      handler: async (input) => {
        if (!isConfigured()) return { data: { count: 0, messages: [], note: 'agent inbox not configured.' }, summary: 'Inbox not configured.' };
        const deadLetter = input.dead_letter === true;
        const ack = deadLetter ? false : (input.ack ?? true);
        const messages = await readMessages(input.agent, { max: input.max ?? 16, ack, deadLetter });
        const mode = deadLetter ? ' (dead letters, read-only)' : ack ? ' (drained)' : ' (peeked)';
        return { data: { count: messages.length, messages }, summary: `${messages.length} message(s) in ${input.agent}'s inbox${mode}.` };
      },
    },
    callerHash,
  );
}
