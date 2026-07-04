import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readInbound, readReconcileMarker } from '../../memory/store.js';

export function registerMemoryInbound(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_inbound',
      category: 'read',
      annotations: {
        title: 'Inbound cross-agent notes on your ledger',
        description:
          'WAKE FIRST-DUTY (read side): list the notes OTHER agents wrote on YOUR shared feed since your last reconcile — attributed hand-offs and suggested corrections. Call this on wake, after recalling your own memory; review each, fold anything valid into your own memory, then call memory_reconcile to ack. Defaults to your token identity; pass "agent" to inspect another lane you own.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {
        agent: z.string().optional().describe('The ledger to check (defaults to your token identity).'),
      },
      outputShape: { count: z.number(), sinceMarker: z.string(), inbound: z.array(z.unknown()) },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { count: 0, sinceMarker: '', inbound: [], note: 'Shared brain not configured.' }, summary: 'Memory store not configured.' };
        const agent = normalizeAgent(input.agent || ctx.callerAgent);
        const marker = await readReconcileMarker(agent);
        const inbound = await readInbound(agent, marker);
        return {
          data: { count: inbound.length, sinceMarker: marker, inbound },
          summary: inbound.length
            ? `📥 ${inbound.length} inbound cross-agent note(s) on ${agent}'s ledger${marker ? ` since ${marker.slice(0, 16)}Z` : ''}. Review, fold in what's valid, then memory_reconcile.`
            : `No new cross-agent notes on ${agent}'s ledger.`,
        };
      },
    },
    callerHash,
  );
}
