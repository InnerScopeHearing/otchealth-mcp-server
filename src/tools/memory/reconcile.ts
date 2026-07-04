import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { isConfigured, normalizeAgent, readInbound, readReconcileMarker, writeReconcileMarker } from '../../memory/store.js';

export function registerMemoryReconcile(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_reconcile',
      category: 'write_simple',
      annotations: {
        title: 'Acknowledge inbound cross-agent notes',
        description:
          'WAKE FIRST-DUTY (ack side): after reviewing memory_inbound and folding any valid updates into your own memory, call this to acknowledge them. It advances your reconcile marker so those notes stop re-surfacing on future memory_inbound / wake. It DELETES NOTHING — the full history stays in the feed. Defaults to your token identity. Pass dry_run=false to persist.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        agent: z.string().optional().describe('The ledger to reconcile (defaults to your token identity).'),
      },
      outputShape: { reconciled: z.boolean(), acked: z.number(), marker: z.string() },
      handler: async (input, ctx) => {
        if (!isConfigured()) return { data: { reconciled: false, acked: 0, marker: '', note: 'Shared brain not configured.' }, summary: 'Memory store not configured.' };
        const agent = normalizeAgent(input.agent || ctx.callerAgent);
        const prev = await readReconcileMarker(agent);
        const pending = await readInbound(agent, prev);
        if (ctx.dryRun) return { data: { reconciled: false, acked: pending.length, marker: prev, note: 'dry_run: pass dry_run=false to persist.' }, summary: `DRY RUN: would ack ${pending.length} inbound note(s) on ${agent}'s ledger.` };
        const marker = new Date().toISOString();
        await writeReconcileMarker(agent, marker);
        return {
          data: { reconciled: true, acked: pending.length, marker },
          summary: `Reconciled ${pending.length} cross-agent note(s) on ${agent}'s ledger; marker -> ${marker}. Nothing deleted; history kept.`,
          audit: { after: { agent, marker, acked: pending.length } },
        };
      },
    },
    callerHash,
  );
}
