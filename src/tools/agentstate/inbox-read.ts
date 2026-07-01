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
          'Read (and by default drain) the messages waiting in an agent\'s inbox. This is how an agent picks up cross-engine handoffs on wake. ack=true (default) removes the messages after reading; ack=false peeks and leaves them (they reappear after a short visibility window).',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().describe('Whose inbox to read (lowercase id).'),
        max: z.number().int().min(1).max(32).optional().describe('Max messages to read (default 16).'),
        ack: z.boolean().optional().describe('Delete after reading (default true). false = peek.'),
      },
      outputShape: { count: z.number(), messages: z.unknown() },
      handler: async (input) => {
        if (!isConfigured()) return { data: { count: 0, messages: [], note: 'agent inbox not configured.' }, summary: 'Inbox not configured.' };
        const messages = await readMessages(input.agent, { max: input.max ?? 16, ack: input.ack ?? true });
        return { data: { count: messages.length, messages }, summary: `${messages.length} message(s) in ${input.agent}'s inbox${input.ack === false ? ' (peeked)' : ' (drained)'}.` };
      },
    },
    callerHash,
  );
}
